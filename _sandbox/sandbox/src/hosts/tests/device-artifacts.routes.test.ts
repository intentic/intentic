import { createHash } from "node:crypto";
import { ARTIFACT_CHUNK_BYTES, type StageArtifact, type StageArtifactResult } from "@intentic/sandbox-contract";
import { Hono } from "hono";
import type { AppEnv } from "../../app-env.js";
import type { Services } from "../../composition.js";
import { createDeviceArtifactRoutes } from "../device-artifacts.routes.js";

// The `devices push` door with a fake computer behind it: what reaches the machine is the agent's bytes in order, in
// chunks of the contract's size, then one commit; and nothing is sent to a computer the turn does not reach, one that is
// offline or too old, or one that already has the build.

interface Fake {
    readonly calls: StageArtifact[];
    readonly app: Hono<AppEnv>;
}

const fake = (over: { reaches?: boolean; online?: boolean; features?: readonly string[]; have?: string; fail?: string } = {}): Fake => {
    const calls: StageArtifact[] = [];
    const client = {
        stageArtifact: async (op: StageArtifact): Promise<StageArtifactResult> => {
            calls.push(op);
            if (over.fail !== undefined && op.op === "commit") {
                throw new Error(over.fail);
            }
            if (op.op === "have") {
                return over.have === undefined ? {} : { path: over.have };
            }
            return op.op === "commit" ? { path: `C:\\runs\\${op.name}\\${op.sha256.slice(0, 12)}\\${op.fileName}` } : {};
        },
    };
    const services = {
        conversations: {} as Services["conversations"],
        turnMounts: { reaches: (conversation: string, target: { kind: string; id: string }) => (over.reaches ?? true) && conversation === "conv-a" && target.id === "rog" },
        hostHub: {
            client: (id: string) => (id === "rog" ? client : undefined),
            online: () => over.online ?? true,
            state: () => ({ facts: { features: over.features ?? ["programs"] } }),
        },
    } as unknown as Pick<Services, "conversations" | "hostHub" | "turnMounts">;
    const app = new Hono<AppEnv>();
    app.post("/devices/:name/artifacts", createDeviceArtifactRoutes(services).push);
    return { calls, app };
};

const bytes = Buffer.alloc(ARTIFACT_CHUNK_BYTES * 2 + 17, 7);
const sha256 = createHash("sha256").update(bytes).digest("hex");
const query = (extra = "") => `?name=intentic-desktop&kind=file&file=intentic-desktop.exe&size=${bytes.byteLength}&sha256=${sha256}${extra}`;
const push = (app: Hono<AppEnv>, device = "rog", extra = "", body: Buffer | undefined = bytes) =>
    app.request(`/devices/${device}/artifacts${query(extra)}`, {
        method: "POST",
        headers: { "x-intentic-conversation": "conv-a" },
        ...(body === undefined ? {} : { body: new Uint8Array(body) }),
    });

test("the bytes reach the computer in order, in the contract's chunk size, then one commit naming where they landed", async () => {
    const { calls, app } = fake();
    const response = await push(app);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
        device: "rog",
        path: `C:\\runs\\intentic-desktop\\${sha256.slice(0, 12)}\\intentic-desktop.exe`,
        size: bytes.byteLength,
        sha256,
        reused: false,
    });
    const chunks = calls.filter((call) => call.op === "chunk");
    expect(chunks.map((call) => call.offset)).toEqual([0, ARTIFACT_CHUNK_BYTES, ARTIFACT_CHUNK_BYTES * 2]);
    expect(Buffer.concat(chunks.map((call) => Buffer.from(call.data, "base64")))).toEqual(bytes);
    expect(calls.at(-1)?.op).toBe("commit");
});

test("a build the computer already has is answered from there, and nothing is sent", async () => {
    const { calls, app } = fake({ have: "C:\\runs\\x" });
    expect(await (await push(app)).json()).toMatchObject({ path: "C:\\runs\\x", reused: true });
    expect(calls.map((call) => call.op)).toEqual(["have"]);
});

test("a probe asks and sends nothing", async () => {
    const { calls, app } = fake();
    expect(await (await push(app, "rog", "&probe=1", undefined)).json()).toEqual({ device: "rog", size: bytes.byteLength, sha256, reused: false });
    expect(calls.map((call) => call.op)).toEqual(["have"]);
});

test("a computer the turn does not reach, one offline, and one too old are refused before anything is sent", async () => {
    for (const [over, status, words] of [
        [{ reaches: false }, 403, "does not reach"],
        [{ online: false }, 409, "not connected"],
        [{ features: [] }, 409, "too old"],
    ] as const) {
        const { calls, app } = fake(over);
        const response = await push(app);
        expect(response.status).toBe(status);
        expect(((await response.json()) as { error: string }).error).toContain(words);
        expect(calls).toEqual([]);
    }
});

test("a push the computer refuses is aborted there, and says how far it got", async () => {
    const { calls, app } = fake({ fail: "Run programs this sandbox sends is switched off" });
    const response = await push(app);
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: string }).error).toContain(`stopped after ${bytes.byteLength} of ${bytes.byteLength} bytes`);
    expect(calls.at(-1)?.op).toBe("abort");
});
