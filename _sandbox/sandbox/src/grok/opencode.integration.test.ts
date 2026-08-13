import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { humanizeModelId, SEED_XAI_MODELS } from "./grok-models.js";
import { createOpenCodeService } from "./opencode.js";

// Capture the server-spawn options instead of booting a real `opencode serve` (client() is otherwise untested).
const { serverSpawns } = vi.hoisted(() => ({ serverSpawns: [] as { config?: unknown }[] }));
vi.mock("@opencode-ai/sdk", () => ({
    createOpencodeServer: async (options: { config?: unknown }) => {
        serverSpawns.push(options);
        return { url: "http://127.0.0.1:0", close: (): void => {} };
    },
    createOpencodeClient: () => ({}),
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
    // An api-key entry has no OAuth access token — and xaiModels() couldn't resolve one either, so "connected"
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

test("xaiModels() returns the seed catalog (non-empty, with a default) when not connected — never blank", async () => {
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

    // xAI stores conversations server-side for 30 days unless each model call opts out — the per-model config
    // options are the only seam OpenCode forwards to the call, so every known id must carry store:false.
    const spawn = serverSpawns.at(-1) as { config: { provider: { xai: { models: Record<string, { options: unknown }> } } } };
    const models = spawn.config.provider.xai.models;
    expect(Object.keys(models).toSorted()).toEqual([...new Set([...SEED_XAI_MODELS, "grok-4-latest"])].toSorted());
    for (const model of Object.values(models)) {
        expect(model.options).toEqual({ store: false });
    }
});

test("recordModels is a no-op for an empty or media-only list (keeps the seed floor)", async () => {
    const xdg = await scratch();
    const service = createOpenCodeService(xdg, { fetchImpl: forbiddenFetch });
    await service.recordModels(["grok-2-image", "grok-imagine-video"]);
    expect(await fileExists(modelsPath(xdg))).toBe(false);
    expect(await service.xaiModels()).toEqual(SEED_CATALOG);
});
