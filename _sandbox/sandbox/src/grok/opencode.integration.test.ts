import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createTurnGate } from "../guard/turn-gate.js";
import { humanizeModelId, SEED_XAI_MODELS } from "./grok-models.js";
import { createOpenCodeService, registerSessionGate, releaseSessionGate } from "./opencode.js";

// Capture the server-spawn options instead of booting a real `opencode serve` (client() is otherwise untested).
// The client is a double too: an event stream the test feeds, and a record of every permission answered on it.
const { serverSpawns, permissionReplies, streamEvents } = vi.hoisted(() => ({
    serverSpawns: [] as { config?: unknown }[],
    permissionReplies: [] as { id: string; permissionID: string; directory: string | undefined; response: string | undefined }[],
    streamEvents: [] as unknown[],
}));
vi.mock("@opencode-ai/sdk", () => ({
    createOpencodeServer: async (options: { config?: unknown }) => {
        serverSpawns.push(options);
        return { url: "http://127.0.0.1:0", close: (): void => {} };
    },
    createOpencodeClient: () => ({
        event: {
            subscribe: async () => ({
                stream: {
                    async *[Symbol.asyncIterator]() {
                        yield* streamEvents;
                        // Then stay open, like the real subscription: a stream that ended would send the
                        // watcher round its retry ladder and spawn a second reader mid-assertion.
                        await new Promise(() => {});
                    },
                },
            }),
        },
        postSessionIdPermissionsPermissionId: async (options: {
            path: { id: string; permissionID: string };
            query?: { directory?: string };
            body?: { response?: string };
        }) => {
            permissionReplies.push({ ...options.path, directory: options.query?.directory, response: options.body?.response });
            return {};
        },
    }),
}));

const roots: string[] = [];
const scratch = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "opencode-"));
    roots.push(root);
    return root;
};

// OpenCode persists provider auth at <XDG_DATA_HOME>/opencode/auth.json (the store connected()/disconnect() use).
const writeAuth = async (xdg: string, auth: unknown): Promise<void> => {
    const dir = join(xdg, "opencode");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "auth.json"), JSON.stringify(auth));
};
const modelsPath = (xdg: string): string => join(xdg, "opencode", "xai-models.json");
const fileExists = async (path: string): Promise<boolean> =>
    access(path)
        .then(() => true)
        .catch(() => false);
// A fetch that fails the test if the discovery path ever touches the network (used to prove it was skipped).
const forbiddenFetch = (() => {
    throw new Error("discovery must not hit the network in this case");
}) as unknown as typeof fetch;
// The catalog the seed floor produces (ids humanized), for the not-connected assertions.
const SEED_CATALOG = { models: SEED_XAI_MODELS.map((id) => ({ id, label: humanizeModelId(id) })), default: SEED_XAI_MODELS[0] };

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    // The three doubles are module-level (vi.hoisted), so a test that fed the stream or answered a permission
    // would otherwise be read by the next one's assertions.
    streamEvents.length = 0;
    permissionReplies.length = 0;
    serverSpawns.length = 0;
});

test("connected('xai') reflects a persisted OAuth token in auth.json, not OpenCode's cached snapshot", async () => {
    const xdg = await scratch();
    const service = createOpenCodeService(xdg);
    // No auth file yet ⇒ not connected.
    expect(await service.connected("xai")).toBe(false);
    // The device flow wrote the OAuth token ⇒ connected, with no opencode-server restart (the snapshot bug this guards).
    await writeAuth(xdg, { xai: { type: "oauth", access: "tok", refresh: "r", expires: 1 } });
    expect(await service.connected("xai")).toBe(true);
});

test("connected('xai') is false for a non-oauth entry or a different provider", async () => {
    const xdg = await scratch();
    const service = createOpenCodeService(xdg);
    // An api-key entry has no OAuth access token, and xaiModels() couldn't resolve one either, so "connected"
    // must stay false to keep the UI consistent with what a turn can actually use.
    await writeAuth(xdg, { xai: { type: "api", key: "sk-xxx" } });
    expect(await service.connected("xai")).toBe(false);
    await writeAuth(xdg, { anthropic: { type: "oauth", access: "tok" } });
    expect(await service.connected("xai")).toBe(false);
});

test("disconnect clears the auth store AND the persisted catalog so connected flips back to false", async () => {
    const xdg = await scratch();
    const service = createOpenCodeService(xdg);
    await writeAuth(xdg, { xai: { type: "oauth", access: "tok" } });
    await service.recordModels(["grok-4"]);
    expect(await service.connected("xai")).toBe(true);
    expect(await fileExists(modelsPath(xdg))).toBe(true);
    await service.disconnect("xai");
    expect(await service.connected("xai")).toBe(false);
    expect(await fileExists(modelsPath(xdg))).toBe(false);
});

test("xaiModels() returns the seed catalog (non-empty, with a default) when not connected: never blank", async () => {
    const xdg = await scratch();
    // No auth ⇒ no token ⇒ discovery is skipped entirely (forbiddenFetch proves it), and the seed floor is served.
    const service = createOpenCodeService(xdg, { fetchImpl: forbiddenFetch });
    expect(await service.xaiModels()).toEqual(SEED_CATALOG);
});

test("xaiModels() skips REST discovery when the token is expired, serving the persisted catalog instead", async () => {
    const xdg = await scratch();
    // expires is a past ms epoch ⇒ every discovery probe would 401, so we must not even try (forbiddenFetch).
    await writeAuth(xdg, { xai: { type: "oauth", access: "tok", expires: 1 } });
    const service = createOpenCodeService(xdg, { fetchImpl: forbiddenFetch });
    await service.recordModels(["grok-4.20-0309-reasoning"]);
    expect(await service.xaiModels()).toEqual({
        models: [{ id: "grok-4.20-0309-reasoning", label: humanizeModelId("grok-4.20-0309-reasoning") }],
        default: "grok-4.20-0309-reasoning",
    });
});

test("xaiModels() discovers live with an unexpired token, then persists the result", async () => {
    const xdg = await scratch();
    await writeAuth(xdg, { xai: { type: "oauth", access: "tok", expires: Number.MAX_SAFE_INTEGER } });
    const liveFetch = (async (url: string | URL) =>
        String(url).endsWith("/v1/models")
            ? new Response(JSON.stringify({ data: [{ id: "grok-4-latest" }] }), { status: 200 })
            : new Response("{}", { status: 404 })) as unknown as typeof fetch;
    const service = createOpenCodeService(xdg, { fetchImpl: liveFetch });
    expect(await service.xaiModels()).toEqual({ models: [{ id: "grok-4-latest", label: "Grok 4 Latest" }], default: "grok-4-latest" });
    // The live result is persisted so a later expired-token read still serves the real catalog.
    expect(JSON.parse(await readFile(modelsPath(xdg), "utf8"))).toEqual(["grok-4-latest"]);
});

test("recordModels persists xAI's named models (chat-only) and xaiModels() serves them next", async () => {
    const xdg = await scratch();
    const service = createOpenCodeService(xdg, { fetchImpl: forbiddenFetch });
    // Media ids are dropped; the survivors are persisted and become the catalog + default.
    await service.recordModels(["grok-4", "grok-2-image", "grok-3"]);
    expect(JSON.parse(await readFile(modelsPath(xdg), "utf8"))).toEqual(["grok-4", "grok-3"]);
    expect(await service.xaiModels()).toEqual({
        models: [
            { id: "grok-4", label: "Grok 4" },
            { id: "grok-3", label: "Grok 3" },
        ],
        default: "grok-4",
    });
});

test("client() spawns the server with store:false for every known xai model (seed + persisted)", async () => {
    const xdg = await scratch();
    const service = createOpenCodeService(xdg, { fetchImpl: forbiddenFetch });
    await service.recordModels(["grok-4-latest"]);
    await service.client();

    // xAI stores conversations server-side for 30 days unless each model call opts out: the per-model config
    // options are the only seam OpenCode forwards to the call, so every known id must carry store:false.
    const spawn = serverSpawns.at(-1) as { config: { provider: { xai: { models: Record<string, { options: unknown }> } } } };
    const models = spawn.config.provider.xai.models;
    expect(Object.keys(models).toSorted()).toEqual([...new Set([...SEED_XAI_MODELS, "grok-4-latest"])].toSorted());
    for (const model of Object.values(models)) {
        expect(model.options).toEqual({ store: false });
    }
});

/* THE PERMISSION BLOCK, IN FULL: the three-key version of this cost a conversation five turns in half an hour.
 *
 * OpenCode defaults every key the config omits to `ask`, and an ask on this runtime reaches nobody: no TUI, no
 * permission channel, no user. The session just stops emitting, and two minutes later the adapter's watchdog
 * calls it a timeout. `external_directory` is the one that found it: an isolated conversation runs in a
 * worktree while its attachments stay on /work, so reading the image the user attached is a read outside the
 * session's own directory. */
test("client() spawns the server with EVERY permission answered, not merely the ones anyone thought of", async () => {
    const xdg = await scratch();
    await createOpenCodeService(xdg, { fetchImpl: forbiddenFetch }).client();
    const spawn = serverSpawns.at(-1) as { config: { permission: Record<string, unknown> } };
    const permission = spawn.config.permission;

    // Every key present and answered. A key left out defaults to `ask`, which is the stall this test exists for.
    expect(Object.keys(permission).toSorted()).toEqual(["bash", "doom_loop", "edit", "external_directory", "webfetch"]);
    for (const key of ["edit", "webfetch", "doom_loop", "external_directory"]) {
        expect(permission[key], key).toBe("allow");
    }

    /* `bash` is the one map, and its DEFAULT is still allow, which is what keeps this test's property true: the
     * owner's command rulebook needs to see a command before it runs (guard/command-gate.ts), and OpenCode's
     * permission channel is the only seam that offers one. So interesting shapes are pre-filtered to `ask` and
     * answered by the real classifier, while everything else keeps the standing yes and never round-trips. */
    const bash = permission["bash"] as Record<string, string>;
    expect(bash["*"]).toBe("allow");
    expect(bash["*git push*"]).toBe("ask");
    expect(bash["*rm *"]).toBe("ask");
    // Nothing in the map may be anything but allow-or-ask: a `deny` here would refuse without ever consulting
    // the rulebook, which is the one verdict this layer must never reach on its own.
    expect([...new Set(Object.values(bash))].toSorted()).toEqual(["allow", "ask"]);
});

/* ...and the same answer given live, for a permission kind this build has never heard of. A future OpenCode's
 * new key is `ask` by default and absent from the config we spawned with, which puts it exactly where
 * external_directory was, so an ask that reaches a watched directory is answered on the spot instead. */
test("a permission ask on a watched directory is answered with a standing yes", async () => {
    const xdg = await scratch();
    streamEvents.push({ type: "permission.updated", properties: { id: "per_1", sessionID: "ses_1", type: "some_future_gate" } });
    await createOpenCodeService(xdg, { fetchImpl: forbiddenFetch, workspaceRoot: "/work" }).client();
    // The watcher reads its stream detached from the boot that started it, so let its first read land.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(permissionReplies).toEqual([{ id: "ses_1", permissionID: "per_1", directory: "/work", response: "always" }]);
});

/* THE OWNER'S RULEBOOK, ANSWERED OVER THIS CHANNEL. A registered session's permissions are judged by the same
 * decide fn every other runtime uses; an unregistered one keeps the standing yes above. This is the whole of
 * what `rulebook: "refuse-only"` claims for Grok and Gemini. */
test("a registered session's permission is judged by the rulebook, and a refused command is rejected", async () => {
    const xdg = await scratch();
    const { gate, release } = createTurnGate({
        commandRules: { "git.destructive": "deny" },
        // What capabilitiesOf("grok", …) declares: this runtime cannot park on a card, so a hold refuses.
        rulebook: "refuse-only",
        signal: new AbortController().signal,
    });
    registerSessionGate("ses_gated", gate);
    streamEvents.push({
        type: "permission.updated",
        properties: { id: "per_2", sessionID: "ses_gated", type: "bash", metadata: { command: "git push --force origin main" }, title: "bash" },
    });
    await createOpenCodeService(xdg, { fetchImpl: forbiddenFetch, workspaceRoot: "/work" }).client();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(permissionReplies).toEqual([{ id: "ses_gated", permissionID: "per_2", directory: "/work", response: "reject" }]);
    releaseSessionGate("ses_gated");
    release();
});

/* An allowed-but-classified command replies `once`, never `always`: `always` would tell OpenCode to stop asking
 * about that pattern for the rest of the session, and the next command matching it could be one the rulebook
 * WOULD refuse. */
test("a command the rulebook allows is approved for this call only", async () => {
    const xdg = await scratch();
    const { gate, release } = createTurnGate({
        commandRules: { "git.destructive": "deny" },
        // What capabilitiesOf("grok", …) declares: this runtime cannot park on a card, so a hold refuses.
        rulebook: "refuse-only",
        signal: new AbortController().signal,
    });
    registerSessionGate("ses_ok", gate);
    streamEvents.push({
        type: "permission.updated",
        properties: { id: "per_3", sessionID: "ses_ok", type: "bash", metadata: { command: "git push origin feature" }, title: "bash" },
    });
    await createOpenCodeService(xdg, { fetchImpl: forbiddenFetch, workspaceRoot: "/work" }).client();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(permissionReplies).toEqual([{ id: "ses_ok", permissionID: "per_3", directory: "/work", response: "once" }]);
    releaseSessionGate("ses_ok");
    release();
});

// A session whose turn has settled, or a delegation nobody registered, is where it always was: the standing yes.
test("an unregistered session keeps the standing yes", async () => {
    const xdg = await scratch();
    streamEvents.push({
        type: "permission.updated",
        properties: { id: "per_4", sessionID: "ses_unknown", type: "bash", metadata: { command: "git push --force origin main" }, title: "bash" },
    });
    await createOpenCodeService(xdg, { fetchImpl: forbiddenFetch, workspaceRoot: "/work" }).client();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(permissionReplies).toEqual([{ id: "ses_unknown", permissionID: "per_4", directory: "/work", response: "always" }]);
});

test("recordModels is a no-op for an empty or media-only list (keeps the seed floor)", async () => {
    const xdg = await scratch();
    const service = createOpenCodeService(xdg, { fetchImpl: forbiddenFetch });
    await service.recordModels(["grok-2-image", "grok-imagine-video"]);
    expect(await fileExists(modelsPath(xdg))).toBe(false);
    expect(await service.xaiModels()).toEqual(SEED_CATALOG);
});
