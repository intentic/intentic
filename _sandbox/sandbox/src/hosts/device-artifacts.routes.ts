import { randomBytes } from "node:crypto";
import {
    ARTIFACT_CHUNK_BYTES,
    ARTIFACT_MAX_BYTES,
    ArtifactFileNameSchema,
    ArtifactKindSchema,
    ArtifactNameSchema,
    DEVICE_FEATURE_PROGRAMS,
    deviceSupports,
    type PushedArtifact,
} from "@intentic/sandbox-contract";
import { errorMessage } from "@intentic/base/errors";
import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app-env.js";
import type { Services } from "../composition.js";
import { soleLiveConversation } from "../conversations/actor/conversation-holdings.js";

// THE `devices push` DOOR: a program the agent built, carried from its shell to one of the owner's computers
// (schemas/device-artifacts.ts). The CLI reads the bytes in the agent's own view of /work, so a build in a conversation's
// private checkout is the one that goes; this route only relays them over the device link in chunks. Reached on the agent
// token, and held to the devices the calling conversation's live turn mounts, so a persona that withholds a computer
// withholds pushing to it too. What may run there is the machine's to decide: it refuses every chunk unless "Run
// programs this sandbox sends" is on.

type DeviceServices = Pick<Services, "conversations" | "hostHub" | "turnMounts">;

const QuerySchema = z.object({
    name: ArtifactNameSchema,
    kind: ArtifactKindSchema,
    file: ArtifactFileNameSchema,
    size: z.coerce.number().int().nonnegative().max(ARTIFACT_MAX_BYTES),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    // Ask whether the machine already has this exact build, and send nothing.
    probe: z.literal("1").optional(),
});

const refuse = (c: Context<AppEnv>, status: 400 | 403 | 404 | 409 | 502, error: string): Response => c.json({ error }, status);

const conversationOf = (services: Pick<Services, "conversations">, c: Context<AppEnv>): string | undefined => {
    const named = c.req.header("x-intentic-conversation");
    return named !== undefined && named !== "" ? named : soleLiveConversation(services.conversations);
};

// The body cut into the machine's chunk size, whatever sizes the socket hands over.
async function* chunksOf(body: ReadableStream<Uint8Array>, size: number): AsyncGenerator<Buffer> {
    let pending: Buffer[] = [];
    let held = 0;
    for await (const piece of body) {
        pending.push(Buffer.from(piece));
        held += piece.byteLength;
        while (held >= size) {
            const whole = Buffer.concat(pending);
            yield whole.subarray(0, size);
            pending = [whole.subarray(size)];
            held = whole.byteLength - size;
        }
    }
    if (held > 0) {
        yield Buffer.concat(pending);
    }
}

export const createDeviceArtifactRoutes = (services: DeviceServices) => ({
    // POST /devices/{name}/artifacts?name=&kind=&file=&size=&sha256=[&probe=1], the bytes as the body.
    push: async (c: Context<AppEnv>): Promise<Response> => {
        const device = c.req.param("name") ?? "";
        const query = QuerySchema.safeParse(c.req.query());
        if (!query.success) {
            return refuse(c, 400, `bad push: ${query.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
        }
        const { name, kind, file, size, sha256, probe } = query.data;
        const conversationId = conversationOf(services, c);
        if (conversationId === undefined) {
            return refuse(c, 400, "no conversation named: run this from an agent's shell");
        }
        if (!services.turnMounts.reaches(conversationId, { kind: "device", id: device })) {
            return refuse(
                c,
                403,
                `this conversation's turn does not reach a device called "${device}": push only to a computer whose tools this turn has (mcp__<name>__…)`,
            );
        }
        const client = services.hostHub.client(device);
        if (client === undefined || !services.hostHub.online(device)) {
            return refuse(c, 409, `"${device}" is not connected right now: the computer is asleep, offline, or its agent isn't running`);
        }
        if (!deviceSupports(services.hostHub.state(device).facts, DEVICE_FEATURE_PROGRAMS)) {
            return refuse(c, 409, `the agent on "${device}" is too old to receive programs: update it there (\`intentic-machine upgrade\`) and push again`);
        }
        const answered = (path: string, reused: boolean): Response => c.json({ device, path, size, sha256, reused } satisfies PushedArtifact);
        try {
            const had = await client.stageArtifact({ op: "have", name, sha256, kind, fileName: file });
            if (had.path !== undefined) {
                return answered(had.path, true);
            }
        } catch (error) {
            return refuse(c, 502, errorMessage(error));
        }
        if (probe !== undefined) {
            return c.json({ device, size, sha256, reused: false });
        }
        const body = c.req.raw.body;
        if (body === null) {
            return refuse(c, 400, "nothing was sent");
        }
        const upload = randomBytes(16).toString("hex");
        let offset = 0;
        try {
            for await (const chunk of chunksOf(body, ARTIFACT_CHUNK_BYTES)) {
                if (offset + chunk.byteLength > size) {
                    throw new Error(`more bytes arrived than the ${size} the push announced`);
                }
                await client.stageArtifact({ op: "chunk", upload, offset, data: chunk.toString("base64") });
                offset += chunk.byteLength;
            }
            const committed = await client.stageArtifact({ op: "commit", upload, name, kind, fileName: file, size, sha256 });
            if (committed.path === undefined) {
                throw new Error(`"${device}" took the bytes but did not say where it put them`);
            }
            return answered(committed.path, false);
        } catch (error) {
            // allow(silent-catch): the abort only tidies the machine's half-written upload; the push already failed and says why
            await client.stageArtifact({ op: "abort", upload }).catch(() => undefined);
            return refuse(c, 502, `the push to "${device}" stopped after ${offset} of ${size} bytes: ${errorMessage(error)}`);
        }
    },
});
