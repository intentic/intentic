import { WORKSPACE_ROOT } from "@intentic/constants";
import { capabilitiesOf, HARNESSES, PROVIDERS } from "@intentic/sandbox-contract";
import { expect, test, vi } from "vitest";

// opencode's health checks whether the feature pack is installed on the machine running the suite (present locally,
// absent in CI); stubbed present so the tests only cover the credential logic.
vi.mock("../../engines/engine-resolve.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../engines/engine-resolve.js")>()),
    engineBinary: async () => "/usr/bin/opencode",
}));
vi.mock("../../platform/boot/on-path.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../platform/boot/on-path.js")>()),
    onPath: async () => true,
}));

const { allAdapters, adapterFor } = await import("./adapter-registry.js");
const ADAPTERS = allAdapters();

// Counterpart to agent-catalog.test.ts: that file demands a capability record for every (provider, harness) pair, this
// one demands the runtime it names actually has an adapter.
test("every provider × harness pair resolves to an adapter for its declared runtime", () => {
    for (const provider of PROVIDERS) {
        for (const harness of HARNESSES) {
            const adapter = adapterFor(provider.value, harness.value);
            expect(adapter).toMatchObject({ runtime: capabilitiesOf(provider.value, harness.value).runtime });
        }
    }
});

// ACP provider ids are open-ended capability ids, not members of PROVIDERS, so this is tested separately.
test("an installed agent capability's id resolves to the ACP adapter", () => {
    expect(adapterFor("some-installed-agent", "native").runtime).toBe("acp");
});

test("each runtime is claimed exactly once", () => {
    const runtimes = ADAPTERS.map((adapter) => adapter.runtime);
    expect(new Set(runtimes).size).toBe(runtimes.length);
});

// Wrong store or wrong arguments loses a conversation's context without anything failing, so calls are recorded, not
// just counted. ACP is the exception: it always answers yes, since the agent's own process resolves resume, not the
// daemon.
test("each runtime is asked about a resume by its own session store", async () => {
    const asked: string[] = [];
    const stores = services({
        sessions: {
            exists: async (cwd: string, id: string) => {
                asked.push(`claude:${cwd}:${id}`);
                return false;
            },
        },
        codexThreadExists: async (id: string) => {
            asked.push(`codex:${id}`);
            return false;
        },
        openCode: {
            sessionExists: async (id: string, cwd: string) => {
                asked.push(`opencode:${id}:${cwd}`);
                return false;
            },
        },
    });

    const held = Object.fromEntries(
        await Promise.all(ADAPTERS.map(async (adapter) => [adapter.runtime, await adapter.holdsSession(stores, "s-1", WORKSPACE_ROOT)])),
    );

    // Twice is correct, not a duplicate: Grok and Gemini share one warm `opencode serve` and its session store, though
    // they're split for health and credentials.
    expect(asked.toSorted()).toEqual(["claude:/work:s-1", "codex:s-1", "opencode:s-1:/work", "opencode:s-1:/work"]);
    // Pi's store is the filesystem: a session-file path that doesn't exist can't resume. Cursor's is the SDK's own
    // local store: no row for an id that was never opened under this cwd, so false rather than a later, less clear
    // failure.
    expect(held).toEqual({
        "claude-code": false,
        codex: false,
        cursor: false,
        opencode: false,
        "opencode-gemini": false,
        acp: true,
        pi: false,
    });
});

// Health is a fact about configuration, stubbed here. The three-state distinction matters: a failed probe must answer
// "unknown", never "unavailable" (which greys a provider out on a blip).
const services = (overrides: Record<string, unknown>) =>
    ({
        config: { translator: { url: "", token: "" }, openaiApiKey: "", anthropicApiKey: "" },
        cliProxy: { accounts: async () => ({ codex: [] }) },
        claudeStore: { list: async () => [] },
        openCode: { connected: async () => false },
        capabilities: { list: async () => [] },
        ...overrides,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

const healthOf = async (runtime: string, overrides: Record<string, unknown> = {}) => {
    const adapter = ADAPTERS.find((entry) => entry.runtime === runtime);
    return adapter!.health(services(overrides));
};

test("a fully unconfigured sandbox reports every runtime unavailable, each naming what to connect", async () => {
    for (const runtime of ["claude-code", "codex", "opencode", "acp", "pi"]) {
        const health = await healthOf(runtime);
        expect(health.state, runtime).toBe("unavailable");
        expect(health.detail, runtime).toEqual(expect.stringMatching(/\S/));
    }
});

test("a configured credential reports ready", async () => {
    expect((await healthOf("claude-code", { config: { translator: { url: "" }, anthropicApiKey: "sk-x", openaiApiKey: "" } })).state).toBe("ready");
    expect((await healthOf("codex", { config: { translator: { url: "" }, anthropicApiKey: "", openaiApiKey: "sk-x" } })).state).toBe("ready");
    expect((await healthOf("opencode", { openCode: { connected: async () => true } })).state).toBe("ready");
    expect((await healthOf("acp", { capabilities: { list: async () => [{ kind: "agent", id: "a" }] } })).state).toBe("ready");
    // Pi needs ITS reserved capability id: an unrelated agent capability is the ACP arm's answer, not Pi's.
    expect((await healthOf("pi", { capabilities: { list: async () => [{ kind: "agent", id: "a" }] } })).state).toBe("unavailable");
    expect((await healthOf("pi", { capabilities: { list: async () => [{ kind: "agent", id: "pi", config: { command: "pi" } }] } })).state).toBe(
        "ready",
    );
});

test("a probe that cannot run answers unknown rather than greying the provider out", async () => {
    const boom = () => {
        throw new Error("network");
    };
    expect((await healthOf("codex", { cliProxy: { accounts: boom }, config: { translator: { url: "http://t" }, openaiApiKey: "" } })).state).toBe(
        "unknown",
    );
    expect((await healthOf("opencode", { openCode: { connected: boom } })).state).toBe("unknown");
    expect((await healthOf("acp", { capabilities: { list: boom } })).state).toBe("unknown");
    expect((await healthOf("pi", { capabilities: { list: boom } })).state).toBe("unknown");
    expect(
        (await healthOf("claude-code", { claudeStore: { list: boom }, config: { translator: { url: "" }, anthropicApiKey: "", openaiApiKey: "" } }))
            .state,
    ).toBe("unknown");
});
