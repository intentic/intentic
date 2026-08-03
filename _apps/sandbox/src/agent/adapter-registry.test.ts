import { capabilitiesOf, HARNESSES, PROVIDERS } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { ADAPTERS, adapterFor } from "./adapter-registry.js";

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
