import { createHash, randomBytes } from "node:crypto";
import { errorMessage } from "@intentic/base/errors";
import {
    type CopiedFile,
    type CopyFile,
    type CopyFileResult,
    CopyKindSchema,
    CopyNameSchema,
    FILE_COPY_CHUNK_BYTES,
    FILE_COPY_MAX_BYTES,
    FILE_COPY_TAR_TIMEOUT_MS,
} from "@intentic/sandbox-contract/schemas/device-files";
import { DEVICE_FEATURE_FILE_COPY, deviceSupports } from "@intentic/sandbox-contract/schemas/hosts";
import { ORPCError } from "@orpc/server";
import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app-env.js";
import { DEVICE_ANSWER_MARGIN_MS, QUICK_CALL_MS } from "../peers/device-call-deadline.js";
import { chunksOf } from "./device-artifacts.routes.js";
import { type DoorServices, refusalFor } from "./device-door.routes.js";
import { defineRawRoutes } from "../http/raw-route-server.js";

// THE `devices copy` DOOR (schemas/device-files.ts): a file or a folder carried between the agent's shell and a path on
// one of the owner's computers, either way. 2026-11-17, the shinobi-society audit: agents moved a 12 MB tarball with
// `docker exec … && docker cp …` through run_command on rog, which only works where this sandbox's container runs on that
// very computer and passes every guard by. The CLI reads and writes the bytes in the agent's own view of /work; this
// route only relays them over the device link a chunk per call, so nothing passes through the model. Held, like `devices
// push`, to the computers the calling conversation's live turn mounts; what the computer allows (its folders, and
// "Create and change files" for a copy onto it) is the computer's to say, on every chunk.

// One piece is 2 MiB: a computer that has not taken or handed one over in this long has gone quiet, not slow.
const CHUNK_DEADLINE_MS = QUICK_CALL_MS;
// Opening a folder's copy packs it, committing one unpacks it: the computer's own bound on that, and its answer.
const TAR_DEADLINE_MS = FILE_COPY_TAR_TIMEOUT_MS + DEVICE_ANSWER_MARGIN_MS;

// What this door asks of a computer's client.
interface Client {
    readonly copyFile: (op: CopyFile, options?: CallOptions) => Promise<CopyFileResult>;
}

const flag = z.literal("1").optional();
const PutQuerySchema = z.object({
    path: z.string().min(1).max(4096),
    name: CopyNameSchema,
    kind: CopyKindSchema,
    size: z.coerce.number().int().nonnegative().max(FILE_COPY_MAX_BYTES),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    overwrite: flag,
    executable: flag,
    // Ask the computer everything a copy would and send nothing: where it would land, or why it is refused.
    probe: flag,
});
const GetQuerySchema = z.object({ path: z.string().min(1).max(4096) });

type PutQuery = z.infer<typeof PutQuerySchema>;

const refuse = (c: Context<AppEnv>, status: 400 | 403 | 404 | 409 | 502, error: string): Response => c.json({ error }, status);

// A call to the computer, settled: its answer, or the status a refusal is sent on. The computer's FORBIDDEN is a switch
// or a folder it does not allow, anything else it said its own refusal, and the rest the link failing.
type Asked<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly status: 403 | 409 | 502; readonly error: string };

const asked = async <T>(call: Promise<T>): Promise<Asked<T>> => {
    try {
        return { ok: true, value: await call };
    } catch (error) {
        const status = error instanceof ORPCError ? (error.code === "FORBIDDEN" ? 403 : 409) : 502;
        return { ok: false, status, error: errorMessage(error) };
    }
};

// The caller may act on the computer, it is connected, and its agent can copy: its client, or the refusal to answer.
const clientFor = (services: DoorServices, c: Context<AppEnv>, device: string): { client: Client } | { refused: Response } => {
    const refused = refusalFor(services, c, device);
    if (refused !== undefined) {
        return { refused: refuse(c, refused.status, refused.error) };
    }
    const client = services.hostHub.client(device);
    if (client === undefined || !services.hostHub.online(device)) {
        return { refused: refuse(c, 409, `"${device}" is not connected right now: the computer is asleep, offline, or its agent isn't running`) };
    }
    if (!deviceSupports(services.hostHub.state(device).facts, DEVICE_FEATURE_FILE_COPY)) {
        return { refused: refuse(c, 409, `the agent on "${device}" is too old to copy files: update it there (\`intentic-machine upgrade\`) and copy again`) };
    }
    return { client };
};

// A call's options: the deadline it is waited on for.
interface CallOptions {
    readonly signal: AbortSignal;
}

const within = (ms: number): CallOptions => ({ signal: AbortSignal.timeout(ms) });

const closeQuietly = async (client: Client, copy: string): Promise<void> => {
    // allow(silent-catch): closing only tidies the computer's half of a copy that already failed and says why
    await client.copyFile({ op: "close", copy }, within(CHUNK_DEADLINE_MS)).catch(() => undefined);
};

// The body, a chunk per call in order, then the commit: where it landed, or why it stopped and after how many bytes.
const relay = async (client: Client, copy: string, body: ReadableStream<Uint8Array> | null, query: PutQuery): Promise<Asked<string | undefined>> => {
    let offset = 0;
    const sent = await asked(
        (async () => {
            for await (const chunk of body === null ? [] : chunksOf(body, FILE_COPY_CHUNK_BYTES)) {
                if (offset + chunk.byteLength > query.size) {
                    throw new Error(`more bytes arrived than the ${query.size} the copy announced`);
                }
                await client.copyFile({ op: "put-chunk", copy, offset, data: chunk.toString("base64") }, within(CHUNK_DEADLINE_MS));
                offset += chunk.byteLength;
            }
            const deadline = query.kind === "tar" ? TAR_DEADLINE_MS : CHUNK_DEADLINE_MS;
            return (await client.copyFile({ op: "put-commit", copy, sha256: query.sha256 }, within(deadline))).path;
        })(),
    );
    return sent.ok ? sent : { ...sent, error: `stopped after ${offset} of ${query.size} bytes: ${sent.error}` };
};

const openOf = (copy: string, query: PutQuery): Extract<CopyFile, { op: "put-open" }> => {
    const { path, name, kind, size } = query;
    const open = { op: "put-open", copy, path, name, kind, size, overwrite: query.overwrite !== undefined, executable: query.executable !== undefined } as const;
    if (query.probe === undefined) {
        return open;
    }
    return { ...open, probe: true };
};

// POST /devices/{name}/files?path=&name=&kind=&size=&sha256=[&overwrite=1][&executable=1][&probe=1], the bytes as the body.
const put = (services: DoorServices) => async (c: Context<AppEnv>): Promise<Response> => {
    const device = c.req.param("name") ?? "";
    const query = PutQuerySchema.safeParse(c.req.query());
    if (!query.success) {
        return refuse(c, 400, `bad copy: ${query.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
    }
    const found = clientFor(services, c, device);
    if ("refused" in found) {
        return found.refused;
    }
    const { client } = found;
    const copy = randomBytes(16).toString("hex");
    const opened = await asked(client.copyFile(openOf(copy, query.data), within(CHUNK_DEADLINE_MS)));
    if (!opened.ok) {
        return refuse(c, opened.status, opened.error);
    }
    const target = opened.value.path ?? query.data.path;
    if (query.data.probe !== undefined) {
        return c.json({ device, path: target });
    }
    const landed = await relay(client, copy, c.req.raw.body, query.data);
    if (!landed.ok) {
        await closeQuietly(client, copy);
        return refuse(c, landed.status, `the copy to "${device}" ${landed.error}`);
    }
    const { kind, size, sha256 } = query.data;
    return c.json({ device, path: landed.value ?? target, kind, size, sha256 } satisfies CopiedFile);
};

// The copy's bytes as a stream the CLI reads at its own pace: each pull asks the computer for the next piece. Its last
// piece carries the computer's hash of everything it served, and bytes that do not match it end the stream as an error
// before that piece, so the CLI's count comes up short rather than its file being wrong.
const streamOf = (client: Client, copy: string, size: number): ReadableStream<Uint8Array> => {
    const hash = createHash("sha256");
    let offset = 0;
    return new ReadableStream<Uint8Array>({
        pull: async (controller) => {
            try {
                const chunk = await client.copyFile({ op: "get-chunk", copy, offset }, within(CHUNK_DEADLINE_MS));
                const bytes = Buffer.from(chunk.data ?? "", "base64");
                if (bytes.byteLength === 0 && offset < size) {
                    throw new Error(`the computer handed over nothing at ${offset} of ${size} bytes`);
                }
                hash.update(bytes);
                offset += bytes.byteLength;
                // The last piece is held back until the hash matches, so a wrong copy is always a short one.
                if (offset >= size && chunk.sha256 !== hash.digest("hex")) {
                    throw new Error("what arrived is not what the computer read");
                }
                controller.enqueue(new Uint8Array(bytes));
                if (offset < size) {
                    return;
                }
                await closeQuietly(client, copy);
                controller.close();
            } catch (error) {
                await closeQuietly(client, copy);
                controller.error(error);
            }
        },
        cancel: async () => {
            await closeQuietly(client, copy);
        },
    });
};

// GET /devices/{name}/files?path=: the bytes as the body; what they are in `x-intentic-copy-*` headers.
const get = (services: DoorServices) => async (c: Context<AppEnv>): Promise<Response> => {
    const device = c.req.param("name") ?? "";
    const query = GetQuerySchema.safeParse(c.req.query());
    if (!query.success) {
        return refuse(c, 400, "bad copy: `path` names what to copy from the computer");
    }
    const found = clientFor(services, c, device);
    if ("refused" in found) {
        return found.refused;
    }
    const { client } = found;
    const copy = randomBytes(16).toString("hex");
    // A folder is packed before this answers, so it waits on the packing's bound.
    const asking = await asked(client.copyFile({ op: "get-open", copy, path: query.data.path }, within(TAR_DEADLINE_MS)));
    if (!asking.ok) {
        return refuse(c, asking.status, asking.error);
    }
    const opened = asking.value;
    const size = opened.size ?? 0;
    return new Response(streamOf(client, copy, size), {
        headers: {
            "content-type": "application/octet-stream",
            "cache-control": "no-store",
            // Encoded, since a header carries Latin-1 alone and a path on the computer is anything.
            "x-intentic-copy-path": encodeURIComponent(opened.path ?? query.data.path),
            "x-intentic-copy-name": encodeURIComponent(opened.name ?? ""),
            "x-intentic-copy-kind": opened.kind ?? "file",
            "x-intentic-copy-size": String(size),
            "x-intentic-copy-executable": opened.executable === true ? "1" : "0",
        },
    });
};

export const createDeviceFileRoutes = (services: DoorServices) => ({ put: put(services), get: get(services) });

// The `devices copy` CLI: a file or a folder between the agent's shell and a path on one of the owner's computers.
export const deviceFileRawRoutes = defineRawRoutes((services: DoorServices) => {
    const routes = createDeviceFileRoutes(services);
    return {
        "POST /devices/{name}/files": routes.put,
        "GET /devices/{name}/files": routes.get,
    };
});
