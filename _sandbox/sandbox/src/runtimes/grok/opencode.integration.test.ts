import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createTurnGate } from "../../guard/turn-gate.js";
import { humanizeModelId } from "../../agent/models/model-discovery.js";
import { SEED_XAI_MODELS } from "./grok-models.js";
import { createOpenCodeService, geminiProviderConfig, registerSessionGate, releaseSessionGate } from "./opencode.js";

// Captures server-spawn options instead of booting a real `opencode serve`; the client double also feeds an event
// stream and records every permission answered.
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
                        // Stays open like the real subscription; ending it would send the watcher round its retry
                        // ladder mid-assertion.
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
// Fails the test if the discovery path ever touches the network.
const forbiddenFetch = (() => {
    throw new Error("discovery must not hit the network in this case");
}) as unknown as typeof fetch;
// The catalog the seed floor produces (ids humanized), for the not-connected assertions.
const SEED_CATALOG = { models: SEED_XAI_MODELS.map((id) => ({ id, label: humanizeModelId(id) })), default: SEED_XAI_MODELS[0] };

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    // The three doubles are module-level (vi.hoisted); reset so one test's stream/permissions don't leak into the next.
    streamEvents.length = 0;
    permissionReplies.length = 0;
    serverSpawns.length = 0;
});

test("connected('xai') reflects a persisted OAuth token in auth.json, not OpenCode's cached snapshot", async () => {
    const xdg = await scratch();
    const service = createOpenCodeService(xdg);
    // No auth file yet ⇒ not connected.
    expect(await service.connected("xai")).toBe(false);
    // OAuth token written by the device flow ⇒ connected, with no opencode-server restart.
    await writeAuth(xdg, { xai: { type: "oauth", access: "tok", refresh: "r", expires: 1 } });
    expect(await service.connected("xai")).toBe(true);
});

test("connected('xai') is false for a non-oauth entry or a different provider", async () => {
    const xdg = await scratch();
    const service = createOpenCodeService(xdg);
    // An api-key entry has no OAuth access token, so "connected" must stay false to match what a turn can actually use.
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
    // expires is a past ms epoch ⇒ every discovery probe would 401, so this must not even try (forbiddenFetch).
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

    // xAI stores conversations server-side unless each model call opts out; per-model config is the only seam OpenCode
    // forwards, so every known id must carry store:false.
    const spawn = serverSpawns.at(-1) as { config: { provider: { xai: { models: Record<string, { options: unknown }> } } } };
    const models = spawn.config.provider.xai.models;
    expect(Object.keys(models).toSorted()).toEqual([...new Set([...SEED_XAI_MODELS, "grok-4-latest"])].toSorted());
    for (const model of Object.values(models)) {
        expect(model.options).toEqual({ store: false });
    }
});

// OpenCode defaults an omitted key to `ask`, which nobody on this runtime can answer, so the turn just stops;
// `external_directory` is the one that found it (attachments read from outside an isolated worktree).
test("client() spawns the server with EVERY permission answered, not merely the ones anyone thought of", async () => {
    const xdg = await scratch();
    await createOpenCodeService(xdg, { fetchImpl: forbiddenFetch }).client();
    const spawn = serverSpawns.at(-1) as { config: { permission: Record<string, unknown> } };
    const permission = spawn.config.permission;

    // Every key must be present: an omitted one defaults to `ask`, which nobody here can answer.
    expect(Object.keys(permission).toSorted()).toEqual(["bash", "doom_loop", "edit", "external_directory", "webfetch"]);
    for (const key of ["edit", "webfetch", "doom_loop", "external_directory"]) {
        expect(permission[key], key).toBe("allow");
    }

    // `bash`'s default is still allow; only shapes the rulebook might care about are pre-filtered to `ask` and answered
    // by the real classifier.
    const bash = permission["bash"] as Record<string, string>;
    expect(bash["*"]).toBe("allow");
    expect(bash["*git push*"]).toBe("ask");
    expect(bash["*rm *"]).toBe("ask");
    // Nothing in the map may be `deny`: that verdict must come from the rulebook, never from this layer alone.
    expect([...new Set(Object.values(bash))].toSorted()).toEqual(["allow", "ask"]);
});

// A future OpenCode permission key defaults to `ask` and is absent from the spawned config, same as
// `external_directory` was; answered on the spot rather than stalling.
test("a permission ask on a watched directory is answered with a standing yes", async () => {
    const xdg = await scratch();
    streamEvents.push({ type: "permission.updated", properties: { id: "per_1", sessionID: "ses_1", type: "some_future_gate" } });
    await createOpenCodeService(xdg, { fetchImpl: forbiddenFetch, workspaceRoot: "/work" }).client();
    // The watcher reads its stream detached from the boot that started it, so let its first read land.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(permissionReplies).toEqual([{ id: "ses_1", permissionID: "per_1", directory: "/work", response: "always" }]);
});

// A registered session's permission goes through the same pipeline every other runtime uses; unregistered keeps the
// standing yes. The judge is a stub: the channel is under test, not the model.
test("a registered session's permission is judged by the policy, and a refused command is rejected", async () => {
    const xdg = await scratch();
    const { gate, release } = createTurnGate({
        judge: async () => ({ decision: "refuse", sentence: "Discards commits the remote has." }),
        // What capabilitiesOf("grok", …) declares: this runtime cannot park on a card, so an ask refuses too.
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

// `always` would stop OpenCode asking about that pattern for the rest of the session, and the next match could be one
// the policy would refuse.
test("a command the policy allows is approved for this call only", async () => {
    const xdg = await scratch();
    const { gate, release } = createTurnGate({
        judge: async () => ({ decision: "allow", sentence: "Pushes a feature branch." }),
        // What capabilitiesOf("grok", …) declares: this runtime cannot park on a card, so an ask refuses too.
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

// OpenCode has no models.dev row for this loopback provider, so an omitted capability defaults to false; a model
// missing "image" input has images stripped from the request.
test("the Google provider declares each model's published modalities, so a screenshot is not stripped out", () => {
    const config = geminiProviderConfig({ baseUrl: "http://127.0.0.1:8789/", token: "local", models: async () => [] }, [
        { id: "claude-opus-4-6-thinking", inputModalities: ["text", "image"] },
        { id: "gemini-pro-agent", inputModalities: ["text", "image", "audio", "video"] },
        { id: "gpt-oss-120b-medium", inputModalities: ["text"] },
    ]);

    const provider = config["intentic-gemini"]!;
    // The trailing slash on the translator URL is normalized away, and the OpenAI surface is under /v1.
    expect(provider.options).toEqual({ baseURL: "http://127.0.0.1:8789/v1", apiKey: "local" });
    expect(provider.models).toEqual({
        "claude-opus-4-6-thinking": { attachment: true, modalities: { input: ["text", "image"], output: ["text"] } },
        "gemini-pro-agent": { attachment: true, modalities: { input: ["text", "image", "audio", "video"], output: ["text"] } },
        // Truthful, not generous: a text-only model on the channel stays text-only.
        "gpt-oss-120b-medium": { attachment: false, modalities: { input: ["text"], output: ["text"] } },
    });
});

// A catalog read that failed must cost Google its provider, not Grok its runtime: one opencode serve is both.
test("no Google models means no Google provider at all, rather than one registered serving nothing", () => {
    expect(geminiProviderConfig({ baseUrl: "http://127.0.0.1:8789", token: "local", models: async () => [] }, [])).toEqual({});
    expect(geminiProviderConfig(undefined, [{ id: "gemini-pro-agent", inputModalities: ["text", "image"] }])).toEqual({});
});
