import type { Capability } from "@intentic/sandbox-contract";
import { machine, type MachineTree } from "./host-machine.testing.js";
import {
    applyProviderKeys,
    endpointId,
    endpointOf,
    keyId,
    keyRows,
    keysInFiles,
    listProviderKeys,
    type ProviderKeyDeps,
    readKeyFiles,
} from "./provider-keys.js";

/* The model API keys a computer already holds, read off it and offered as endpoints: keys only, never a login. */

const files = (entries: Record<string, string>): Map<string, string> => new Map(Object.entries(entries));

// One file per source, each also holding what must NOT be taken: OAuth logins, a pointer, tokens that are no model's.
const HOME = {
    ".hermes/.env": [
        "ANTHROPIC_API_KEY=test-anthropic-key-0001",
        "OPENROUTER_API_KEY=test-openrouter-key-0002",
        // A pointer to another store, not a key.
        "OPENAI_API_KEY=${OPENAI_KEY}",
        // Keys, but no model's: search and chat-bot tokens stay where they are.
        "BRAVE_API_KEY=test-brave-key-00000003",
        "TELEGRAM_BOT_TOKEN=test-telegram-token-04",
    ].join("\n"),
    ".hermes/auth.json": JSON.stringify({
        nous: { access_token: "test-access-token-0005", refresh_token: "test-refresh-token-06" },
        deepseek: { api_key: "test-deepseek-key-00007" },
    }),
    ".openclaw/agents/main/agent/auth-profiles.json": JSON.stringify({
        version: 1,
        profiles: {
            "google:default": { type: "api_key", provider: "google", key: "test-gemini-key-000008" },
            "openai-codex:default": { type: "oauth", provider: "openai-codex", access: "test-oauth-access-09", refresh: "test-oauth-refresh-10" },
            // The same Anthropic key Hermes holds: one row, attributed to Hermes.
            "anthropic:default": { type: "api_key", provider: "anthropic", key: "test-anthropic-key-0001" },
        },
    }),
    ".local/share/opencode/auth.json": JSON.stringify({
        groq: { type: "api", key: "test-groq-key-00000011" },
        anthropic: { type: "oauth", refresh: "test-oauth-refresh-12", access: "test-oauth-access-13", expires: 1 },
        "some-gateway": { type: "api", key: "test-gateway-key-00014" },
    }),
    ".gemini/.env": "GEMINI_API_KEY=test-gemini-cli-key-015\n",
    ".codex/auth.json": JSON.stringify({ OPENAI_API_KEY: "test-openai-key-000016", tokens: { id_token: "x", access_token: "y", refresh_token: "z" } }),
};

test("each tool's file gives up its API keys and nothing else", () => {
    expect(keysInFiles(files(HOME))).toEqual([
        { provider: "anthropic", source: "hermes", key: "test-anthropic-key-0001" },
        { provider: "openrouter", source: "hermes", key: "test-openrouter-key-0002" },
        { provider: "deepseek", source: "hermes", key: "test-deepseek-key-00007" },
        { provider: "anthropic", source: "openclaw", key: "test-anthropic-key-0001" },
        { provider: "google", source: "openclaw", key: "test-gemini-key-000008" },
        { provider: "groq", source: "opencode", key: "test-groq-key-00000011" },
        { provider: "some-gateway", source: "opencode", key: "test-gateway-key-00014" },
        { provider: "gemini", source: "gemini", key: "test-gemini-cli-key-015" },
        { provider: "openai", source: "codex", key: "test-openai-key-000016" },
    ]);
});

test("a ChatGPT-only Codex login, an unreadable file and an empty home hold no key", () => {
    expect(keysInFiles(files({ ".codex/auth.json": JSON.stringify({ OPENAI_API_KEY: null, tokens: { refresh_token: "test-refresh-token-17" } }) }))).toEqual(
        [],
    );
    expect(keysInFiles(files({ ".hermes/auth.json": "{ not json", ".local/share/opencode/auth.json": "[]" }))).toEqual([]);
    expect(keysInFiles(new Map())).toEqual([]);
});

test("rows: one per distinct key, named by its provider, never carrying the key", () => {
    const found = keysInFiles(files(HOME)).map((key) => ({ host: "laptop", key }));
    const held: Capability[] = [
        { id: "groq", kind: "endpoint", config: { baseUrl: "https://api.groq.com/openai/v1", protocol: "openai", apiKey: "test-groq-key-00000011" } },
    ];
    const rows = keyRows(found, held);
    expect(rows.map((row) => [row.provider, row.label, row.source, row.hint, row.applicable, row.added])).toEqual([
        ["anthropic", "Anthropic", "hermes", "0001", true, false],
        ["openrouter", "OpenRouter", "hermes", "0002", true, false],
        ["deepseek", "DeepSeek", "hermes", "0007", true, false],
        // OpenClaw files Gemini under Google; the row uses this sandbox's name for it.
        ["gemini", "Gemini", "openclaw", "0008", true, false],
        ["groq", "Groq", "opencode", "0011", true, true],
        // A provider with no known address is reported in the source's own words, and not offered.
        ["some-gateway", "some-gateway", "opencode", "0014", false, false],
        ["gemini", "Gemini", "gemini", "-015", true, false],
        ["openai", "OpenAI", "codex", "0016", true, false],
    ]);
    expect(rows.every((row) => row.host === "laptop")).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("test-anthropic-key");
    expect(rows[0]?.id).toBe(keyId("test-anthropic-key-0001"));
    expect(rows[0]?.id).toMatch(/^key-[0-9a-f]{16}$/);
});

test("a known provider becomes the vendor's own endpoint; ids number past the ones taken", () => {
    expect(endpointOf({ provider: "anthropic", source: "hermes", key: "test-anthropic-key-0001" })).toEqual({
        baseUrl: "https://api.anthropic.com",
        protocol: "anthropic",
        apiKey: "test-anthropic-key-0001",
    });
    expect(endpointOf({ provider: "google", source: "openclaw", key: "test-gemini-key-000008" })).toEqual({
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
        protocol: "openai",
        apiKey: "test-gemini-key-000008",
    });
    expect(endpointOf({ provider: "some-gateway", source: "opencode", key: "test-gateway-key-00014" })).toBeUndefined();
    expect(endpointId("openai", new Set())).toBe("openai");
    expect(endpointId("openai", new Set(["openai", "openai-2"]))).toBe("openai-3");
});

test("the device read asks for the fixed files and each OpenClaw agent's, and nothing else", async () => {
    const tree = {
        "/home/me": null,
        "/home/me/.hermes": null,
        "/home/me/.hermes/.env": HOME[".hermes/.env"],
        // Never asked for: a walk is not what this is.
        "/home/me/.hermes/SOUL.md": "Be warm.",
        "/home/me/.openclaw": null,
        "/home/me/.openclaw/agents": null,
        "/home/me/.openclaw/agents/main": null,
        "/home/me/.openclaw/agents/main/agent": null,
        "/home/me/.openclaw/agents/main/agent/auth-profiles.json": HOME[".openclaw/agents/main/agent/auth-profiles.json"],
    } satisfies MachineTree;
    const { hub, calls } = machine(tree);
    const read = await readKeyFiles(hub, { id: "laptop", home: "/home/me" });
    expect([...read.keys()].toSorted()).toEqual([".hermes/.env", ".openclaw/agents/main/agent/auth-profiles.json"]);
    expect(calls.toSorted()).toEqual(
        [
            "list_dir /home/me/.openclaw/agents",
            "read_file /home/me/.hermes/.env",
            "read_file /home/me/.hermes/auth.json",
            "read_file /home/me/.local/share/opencode/auth.json",
            "read_file /home/me/.gemini/.env",
            "read_file /home/me/.codex/auth.json",
            "read_file /home/me/.openclaw/agents/main/agent/auth-profiles.json",
        ].toSorted(),
    );
});

test("a Windows home is addressed with its own separator", async () => {
    const { hub, calls } = machine({ "C:\\Users\\me": null, "C:\\Users\\me\\.gemini\\.env": "GEMINI_API_KEY=test-gemini-cli-key-015\n" }, "\\");
    const read = await readKeyFiles(hub, { id: "desktop", home: "C:\\Users\\me" });
    expect([...read.entries()]).toEqual([[".gemini/.env", "GEMINI_API_KEY=test-gemini-cli-key-015\n"]]);
    expect(calls).toContain("read_file C:\\Users\\me\\.local\\share\\opencode\\auth.json");
});

// Deps over a pretend device and a manifest in memory, recording what the apply writes.
const keyDeps = (tree: MachineTree, capabilities: Capability[] = [], refuse?: string) => {
    const added: Capability[] = [];
    let settles = 0;
    const deps: ProviderKeyDeps = {
        hub: machine(tree).hub,
        devices: async () => (Object.keys(tree).length === 0 ? [] : [{ id: "laptop", home: "/home/me" }]),
        capabilities: async () => [...capabilities, ...added],
        addEndpoint: async (capability) => {
            if (capability.id === refuse) {
                throw new Error("the endpoint refused the key");
            }
            added.push(capability);
        },
        settle: async () => {
            settles += 1;
        },
    };
    return { deps, added, settled: () => settles };
};

const TREE = {
    "/home/me": null,
    "/home/me/.hermes/.env": HOME[".hermes/.env"],
    "/home/me/.local/share/opencode/auth.json": HOME[".local/share/opencode/auth.json"],
} satisfies MachineTree;

test("no connected device is an empty list, not an error", async () => {
    expect(await listProviderKeys(keyDeps({}).deps)).toEqual([]);
});

test("adding keys makes endpoints, read off the device again, and settles once", async () => {
    const openai: Capability = { id: "openai", kind: "endpoint", config: { baseUrl: "https://api.openai.com/v1", protocol: "openai" } };
    const { deps, added, settled } = keyDeps(TREE, [openai]);
    const rows = await listProviderKeys(deps);
    const id = (provider: string): string => rows.find((row) => row.provider === provider)?.id ?? "";

    const applied = await applyProviderKeys(deps, [id("anthropic"), id("openrouter"), id("some-gateway"), "key-0000000000000000"]);
    expect(applied.added).toEqual([
        { id: id("anthropic"), capability: "anthropic" },
        { id: id("openrouter"), capability: "openrouter" },
    ]);
    expect(applied.failed).toEqual([
        { id: id("some-gateway"), error: expect.stringContaining("does not know where some-gateway serves models") },
        { id: "key-0000000000000000", error: "that key is no longer on a connected device" },
    ]);
    expect(added).toEqual([
        { id: "anthropic", kind: "endpoint", config: { baseUrl: "https://api.anthropic.com", protocol: "anthropic", apiKey: "test-anthropic-key-0001" } },
        { id: "openrouter", kind: "endpoint", config: { baseUrl: "https://openrouter.ai/api/v1", protocol: "openai", apiKey: "test-openrouter-key-0002" } },
    ]);
    expect(settled()).toBe(1);

    // Again: already there, so named and not added twice, and nothing to settle.
    const again = await applyProviderKeys(deps, [id("anthropic")]);
    expect(again).toEqual({ added: [{ id: id("anthropic"), capability: "anthropic" }], failed: [] });
    expect(added).toHaveLength(2);
    expect(settled()).toBe(1);
    expect((await listProviderKeys(deps)).find((row) => row.provider === "anthropic")?.added).toBe(true);
});

test("an id already taken is numbered past, and one refused add is one failed row", async () => {
    const taken: Capability = { id: "groq", kind: "mcp", config: { url: "https://mcp.example.com" } };
    const { deps, added } = keyDeps(TREE, [taken], "anthropic");
    const rows = await listProviderKeys(deps);
    const id = (provider: string): string => rows.find((row) => row.provider === provider)?.id ?? "";

    const applied = await applyProviderKeys(deps, [id("groq"), id("anthropic")]);
    expect(applied.added).toEqual([{ id: id("groq"), capability: "groq-2" }]);
    expect(applied.failed).toEqual([{ id: id("anthropic"), error: "the endpoint refused the key" }]);
    expect(added.map((capability) => capability.id)).toEqual(["groq-2"]);
});
