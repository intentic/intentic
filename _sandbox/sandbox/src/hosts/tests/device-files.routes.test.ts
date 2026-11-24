import { createHash } from "node:crypto";
import { type CopyFile, type CopyFileResult, FILE_COPY_CHUNK_BYTES } from "@intentic/sandbox-contract/schemas/device-files";
import { ORPCError } from "@orpc/server";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../app-env.js";
import type { DeviceFacts } from "@intentic/sandbox-contract/schemas/hosts";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../composition.js";
import type { DoorServices } from "../device-door.routes.js";
import { createDeviceFileRoutes } from "../device-files.routes.js";
import type { HostClient } from "../host-peer.js";
import { provenTurnHeaders } from "../../seams/workload-stamp.testing.js";

// The `devices copy` door with a fake computer behind it: a copy onto it reaches the machine as the agent's bytes in
// order, a chunk of the contract's size per call, then one commit; a copy off it streams the machine's chunks back and
// ends short when they do not match the hash the machine sent; and nothing is asked of a computer the turn does not
// reach, one offline or one too old. A refusal on the computer (a switch, a folder) comes back as 403.

interface Fake {
    readonly calls: CopyFile[];
    readonly app: Hono<AppEnv>;
}

interface Over {
    readonly reaches?: boolean;
    readonly online?: boolean;
    readonly features?: readonly string[];
    // The op the computer refuses, and how: a FORBIDDEN refusal or a plain failure.
    readonly refuse?: { readonly op: CopyFile["op"]; readonly forbidden: boolean };
    // What the computer serves for a get, and the hash it claims for it.
    readonly serves?: Buffer;
    readonly claims?: string;
}

const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

const answer = (op: CopyFile, over: Over): CopyFileResult => {
    const served = over.serves ?? Buffer.alloc(0);
    switch (op.op) {
        case "put-open":
            return { path: `C:\\Users\\me\\${op.name}` };
        case "put-commit":
            return { path: "C:\\Users\\me\\landed.bin" };
        case "get-open":
            return { path: op.path, kind: "file", size: served.byteLength, name: "dump.bin", executable: false };
        case "get-chunk": {
            const piece = served.subarray(op.offset, op.offset + FILE_COPY_CHUNK_BYTES);
            const last = op.offset + piece.byteLength >= served.byteLength;
            return last ? { data: piece.toString("base64"), sha256: over.claims ?? sha(served) } : { data: piece.toString("base64") };
        }
        default:
            return {};
    }
};

const fake = (over: Over = {}): Fake => {
    const calls: CopyFile[] = [];
    const client = {
        copyFile: async (op: CopyFile): Promise<CopyFileResult> => {
            calls.push(op);
            if (over.refuse?.op === op.op) {
                throw over.refuse.forbidden ? new ORPCError("FORBIDDEN", { message: `Refused: "Create and change files" is switched off` }) : new Error("the link dropped");
            }
            return answer(op, over);
        },
    };
    const services = unstubbed<DoorServices>("services", {
        conversations: unstubbed<Services["conversations"]>("conversations", {}),
        runGrants: unstubbed<Services["runGrants"]>("runGrants", { allows: () => false }),
        turnMounts: unstubbed<Services["turnMounts"]>("turnMounts", {
            reaches: (conversation, target) => (over.reaches ?? true) && conversation === "conv-a" && target.kind === "device" && target.id === "rog",
        }),
        hostHub: unstubbed<Services["hostHub"]>("hostHub", {
            client: (id) => (id === "rog" ? unstubbed<HostClient>("client", client) : undefined),
            online: () => over.online ?? true,
            state: () => unstubbed<ReturnType<Services["hostHub"]["state"]>>("state", { facts: unstubbed<DeviceFacts>("facts", { features: [...(over.features ?? ["file-copy"])] }) }),
        }),
    });
    const app = new Hono<AppEnv>();
    const routes = createDeviceFileRoutes(services);
    app.post("/devices/:name/files", routes.put);
    app.get("/devices/:name/files", routes.get);
    return { calls, app };
};

const bytes = Buffer.alloc(FILE_COPY_CHUNK_BYTES * 2 + 17, 7);
const headers = provenTurnHeaders("conv-a");
const putQuery = (extra = "") => `?path=${encodeURIComponent("C:\\Users\\me")}&name=tool.bin&kind=file&size=${bytes.byteLength}&sha256=${sha(bytes)}${extra}`;
const put = (app: Hono<AppEnv>, extra = "", body: Buffer | undefined = bytes) => {
    const init: RequestInit = { method: "POST", headers };
    if (body !== undefined) {
        init.body = new Uint8Array(body);
    }
    return app.request(`/devices/rog/files${putQuery(extra)}`, init);
};

// What a refused route answers.
const RefusalSchema = z.object({ error: z.string() });
const refusalOf = async (response: Response): Promise<string> => RefusalSchema.parse(await response.json()).error;
const get = (app: Hono<AppEnv>, device = "rog") => app.request(`/devices/${device}/files?path=${encodeURIComponent("C:\\dumps\\dump.bin")}`, { headers });

test("a copy onto the computer reaches it in order, in the contract's chunk size, then one commit naming where it landed", async () => {
    const { calls, app } = fake();
    const response = await put(app, "&overwrite=1&executable=1");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ device: "rog", path: "C:\\Users\\me\\landed.bin", kind: "file", size: bytes.byteLength, sha256: sha(bytes) });
    expect(calls[0]).toMatchObject({ op: "put-open", path: "C:\\Users\\me", name: "tool.bin", overwrite: true, executable: true });
    const chunks = calls.filter((call) => call.op === "put-chunk");
    expect(chunks.map((call) => call.offset)).toEqual([0, FILE_COPY_CHUNK_BYTES, FILE_COPY_CHUNK_BYTES * 2]);
    expect(Buffer.concat(chunks.map((call) => Buffer.from(call.data, "base64")))).toEqual(bytes);
    expect(calls.at(-1)).toEqual({ op: "put-commit", copy: calls[0]?.copy ?? "", sha256: sha(bytes) });
});

test("a probe asks the computer where it would land and sends nothing", async () => {
    const { calls, app } = fake();
    expect(await (await put(app, "&probe=1", undefined)).json()).toEqual({ device: "rog", path: "C:\\Users\\me\\tool.bin" });
    expect(calls.map((call) => call.op)).toEqual(["put-open"]);
    expect(calls[0]).toMatchObject({ probe: true });
});

test("a switch that is off on the computer refuses before a byte is sent, and reads as refused", async () => {
    const { calls, app } = fake({ refuse: { op: "put-open", forbidden: true } });
    const response = await put(app);
    expect(response.status).toBe(403);
    expect(await refusalOf(response)).toContain("Create and change files");
    expect(calls.map((call) => call.op)).toEqual(["put-open"]);
});

test("a copy that fails part-way is closed on the computer, and says how far it got", async () => {
    const { calls, app } = fake({ refuse: { op: "put-commit", forbidden: false } });
    const response = await put(app);
    expect(response.status).toBe(502);
    expect(await refusalOf(response)).toContain(`stopped after ${bytes.byteLength} of ${bytes.byteLength} bytes: the link dropped`);
    expect(calls.at(-1)?.op).toBe("close");
});

test("a computer the turn does not reach, one offline, and one too old are refused before anything is asked of it", async () => {
    for (const [over, status, words] of [
        [{ reaches: false }, 403, "does not reach"],
        [{ online: false }, 409, "not connected"],
        [{ features: ["programs"] }, 409, "too old to copy files"],
    ] as const) {
        const { calls, app } = fake(over);
        for (const response of [await put(app), await get(app)]) {
            expect(response.status).toBe(status);
            expect(await refusalOf(response)).toContain(words);
        }
        expect(calls).toEqual([]);
    }
});

test("a copy off the computer streams its chunks in order, says what it is in headers, and closes the copy at the end", async () => {
    const { calls, app } = fake({ serves: bytes });
    const response = await get(app);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-intentic-copy-size")).toBe(String(bytes.byteLength));
    expect(response.headers.get("x-intentic-copy-kind")).toBe("file");
    expect(decodeURIComponent(response.headers.get("x-intentic-copy-path") ?? "")).toBe("C:\\dumps\\dump.bin");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect(calls.filter((call) => call.op === "get-chunk").map((call) => call.offset)).toEqual([0, FILE_COPY_CHUNK_BYTES, FILE_COPY_CHUNK_BYTES * 2]);
    expect(calls.at(-1)?.op).toBe("close");
});

test("bytes that do not match the computer's hash end the stream as an error rather than as a file", async () => {
    const { calls, app } = fake({ serves: bytes, claims: "0".repeat(64) });
    const response = await get(app);
    expect(response.status).toBe(200);
    await expect(response.arrayBuffer()).rejects.toThrow("not what the computer read");
    expect(calls.at(-1)?.op).toBe("close");
});

test("a path the computer does not allow is refused as such, with nothing streamed", async () => {
    const { app } = fake({ refuse: { op: "get-open", forbidden: true } });
    const response = await get(app);
    expect(response.status).toBe(403);
});
