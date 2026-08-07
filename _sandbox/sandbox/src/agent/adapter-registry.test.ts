import { capabilitiesOf, HARNESSES, PROVIDERS } from "@intentic/sandbox-contract";
import { expect, test, vi } from "vitest";

/* WHICH BINARIES THE IMAGE CARRIES IS NOT WHAT THIS FILE ASSERTS. The opencode arm's health asks the real PATH
 * whether the feature pack is installed, which makes its answer a property of the machine the suite happens to
 * run on: present on a developer's box, absent in the CI container, and the assertions below are about the
 * CREDENTIAL logic either way. Stubbed present so the unit tests one thing.
 *
 * Spread over the real module rather than replaced wholesale — `resolveOnPath` is reached from elsewhere in
 * this graph, and a factory naming only `onPath` would leave that one undefined. */
vi.mock("../platform/on-path.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../platform/on-path.js")>()),
    onPath: async () => true,
}));

const { ADAPTERS, adapterFor } = await import("./adapter-registry.js");

/* The guard the registry's own comment promises, and the counterpart to agent-catalog.test.ts: that file
 * demands every (provider, harness) pair have a capability record, this one demands the runtime that record
 * names have somewhere to run. Between them, a provider cannot be added and left half-wired. */
test("every provider × harness pair resolves to an adapter for its declared runtime", () => {
    for (const provider of PROVIDERS) {
        for (const harness of HARNESSES) {
            const adapter = adapterFor(provider.value, harness.value);
            expect(adapter, `${provider.value}/${harness.value}`).toBeDefined();
            // Not merely "an adapter" — the one the contract says serves this pair. A table that resolved every
            // pair to the same arm would pass a mere existence check and route every turn to Claude.
            expect(adapter.runtime, `${provider.value}/${harness.value}`).toBe(capabilitiesOf(provider.value, harness.value).runtime);
        }
    }
});

// An ACP provider is an installed capability id, not a member of PROVIDERS — covered separately because it is
// the one arm whose provider ids are open-ended.
test("an installed agent capability's id resolves to the ACP adapter", () => {
    expect(adapterFor("some-installed-agent", "native").runtime).toBe("acp");
});

test("each runtime is claimed exactly once", () => {
    const runtimes = ADAPTERS.map((adapter) => adapter.runtime);
    expect(new Set(runtimes).size).toBe(runtimes.length);
});

/* WHICH STORE EACH RUNTIME IS ASKED ABOUT A RESUME. The answer decides whether a turn continues a conversation
 * or opens a blank one, so an arm wired to the wrong store — or to the right one with its arguments the wrong
 * way round, which is why the calls are recorded rather than counted — loses a conversation its context without
 * anything failing. ACP is the deliberate exception: its sessions live inside the agent's own process, where the
 * daemon cannot see them, so it answers yes and lets the agent itself say otherwise at resume time. */
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
        await Promise.all(ADAPTERS.map(async (adapter) => [adapter.runtime, await adapter.holdsSession(stores, "s-1", "/work")])),
    );

    expect(asked.toSorted()).toEqual(["claude:/work:s-1", "codex:s-1", "opencode:s-1:/work"]);
    expect(held).toEqual({ "claude-code": false, codex: false, opencode: false, acp: true });
});

/* Health is a fact about the daemon's configuration, so it is probed against a stubbed one. What matters here
 * is the THREE-STATE distinction: a probe that fails must answer "unknown", never "unavailable" — the latter
 * greys a provider out, and doing that because an account listing blipped is worse than saying nothing. */
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
    for (const runtime of ["claude-code", "codex", "opencode", "acp"]) {
        const health = await healthOf(runtime);
        expect(health.state, runtime).toBe("unavailable");
        expect(health.detail, runtime).toBeTruthy();
    }
});

test("a configured credential reports ready", async () => {
    expect((await healthOf("claude-code", { config: { translator: { url: "" }, anthropicApiKey: "sk-x", openaiApiKey: "" } })).state).toBe("ready");
    expect((await healthOf("codex", { config: { translator: { url: "" }, anthropicApiKey: "", openaiApiKey: "sk-x" } })).state).toBe("ready");
    expect((await healthOf("opencode", { openCode: { connected: async () => true } })).state).toBe("ready");
    expect((await healthOf("acp", { capabilities: { list: async () => [{ kind: "agent", id: "a" }] } })).state).toBe("ready");
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
    expect(
        (await healthOf("claude-code", { claudeStore: { list: boom }, config: { translator: { url: "" }, anthropicApiKey: "", openaiApiKey: "" } }))
            .state,
    ).toBe("unknown");
});
