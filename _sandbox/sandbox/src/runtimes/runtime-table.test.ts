import { WORKSPACE_ROOT } from "@intentic/constants";
import { capabilitiesOf, HARNESSES, MINTED_PROVIDERS, NATIVE_PROVIDERS, PROVIDERS } from "@intentic/sandbox-contract";
import * as onPathOriginal from "../image/on-path.js";
import * as engineResolveOriginal from "../engines/engine-resolve.js";
import * as filesystemOriginal from "node:fs/promises";
import * as cursorSdkOriginal from "./cursor/cursor-sdk.js";
import { unstubbed } from "@intentic/testing";
import type { RuntimeDeps } from "./runtime-table.js";
import { AgentDomainRefusedError } from "../workload/agent-execution.js";
import { rootExecution } from "../workload/agent-execution.testing.js";
import { domainExecution } from "./execution.testing.js";

// Session probes exercise only fake stores/SDK/filesystem seams, never the ambient local session state.
const missing = Object.assign(new Error("missing session"), { code: "ENOENT" });
const piAccess = jest.fn<(path: unknown) => Promise<void>>(async () => {
    throw missing;
});
const cursorList = jest.fn<(input: { runtime: string; cwd: string }) => Promise<{ items: { agentId: string }[] }>>(async () => ({ items: [] }));
const cursorSdk = jest.fn(async () => ({ Agent: { list: cursorList } }));
jest.mock("node:fs/promises", () => ({ ...filesystemOriginal, access: piAccess }));
jest.mock("./cursor/cursor-sdk.js", () => ({ ...cursorSdkOriginal, cursorSdk }));
beforeEach(() => {
    jest.clearAllMocks();
    cursorSdk.mockImplementation(async () => ({ Agent: { list: cursorList } }));
});

// opencode's health checks whether the feature pack is installed on the machine running the suite (present locally,
// absent in CI); stubbed present so the tests only cover the credential logic.
jest.mock("../engines/engine-resolve.js", async () => ({
    ...engineResolveOriginal,
    engineBinary: async () => "/usr/bin/opencode",
    engineReady: async () => true,
}));
jest.mock("../image/on-path.js", async () => ({
    ...onPathOriginal,
    onPath: async () => true,
}));

const { PROVIDER_MODULES, RUNTIME_ADAPTERS } = await import("./runtime-table.js");
const ADAPTERS = RUNTIME_ADAPTERS.all;

// Counterpart to agent-catalog.test.ts: that file demands a capability record for every (provider, harness) pair, this
// one demands the runtime it names actually has an adapter.
test("every provider × harness pair resolves to an adapter for its declared runtime", () => {
    for (const provider of PROVIDERS) {
        for (const harness of HARNESSES) {
            const adapter = RUNTIME_ADAPTERS.for(provider.value, harness.value);
            expect(adapter).toMatchObject({ runtime: capabilitiesOf(provider.value, harness.value).runtime });
        }
    }
});

// ACP provider ids are open-ended capability ids, not members of PROVIDERS, so this is tested separately.
test("an installed agent capability's id resolves to the ACP adapter", () => {
    expect(RUNTIME_ADAPTERS.for("some-installed-agent", "native").runtime).toBe("acp");
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

    cursorList.mockImplementationOnce(async ({ runtime, cwd }) => {
        asked.push(`cursor:${runtime}:${cwd}`);
        return { items: [] };
    });
    piAccess.mockImplementationOnce(async (path) => {
        asked.push(`pi:${String(path)}`);
        throw missing;
    });
    const execution = rootExecution({ localCwd: WORKSPACE_ROOT });
    let held: Record<string, boolean>;
    try {
        held = Object.fromEntries(
            await Promise.all(ADAPTERS.map(async (adapter) => [adapter.runtime, await adapter.holdsSession(stores, "s-1", execution.context)])),
        );
    } finally {
        execution.release();
    }

    // Twice is correct, not a duplicate: Grok and Gemini share one warm `opencode serve` and its session store, though
    // they're split for health and credentials.
    expect(asked.toSorted()).toEqual(["claude:/work:s-1", "codex:s-1", "cursor:local:/work", "opencode:s-1:/work", "opencode:s-1:/work", "pi:s-1"]);
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

test.each(["forged", "released", "stale"] as const)(
    "every session probe refuses %s authority before any store, SDK or filesystem access",
    async (kind) => {
        const execution = rootExecution({ localCwd: WORKSPACE_ROOT });
        const domain = kind === "stale" ? await domainExecution(64301) : undefined;
        if (kind === "released") {
            execution.release();
        }
        domain?.retire();
        const context = kind === "forged" ? { ...execution.context } : (domain?.context ?? execution.context);
        const unavailable = unstubbed<RuntimeDeps>("stores must not be consulted", {});
        try {
            for (const adapter of ADAPTERS) {
                const failed = adapter.holdsSession(unavailable, "s-1", context);
                await expect(failed).rejects.toBeInstanceOf(AgentDomainRefusedError);
                await expect(failed).rejects.toMatchObject({ code: "agent-domain-refused" });
            }
            expect(cursorSdk).not.toHaveBeenCalled();
            expect(cursorList).not.toHaveBeenCalled();
            expect(piAccess).not.toHaveBeenCalled();
        } finally {
            execution.release();
            domain?.release();
        }
    },
);

test("unplaced session stores and process-capable probes stay closed to issued unprivileged contexts", async () => {
    const execution = await domainExecution(64302);
    const unavailable = unstubbed<RuntimeDeps>("unplaced stores must not be consulted", {});
    // Claude Code's store is placed: the domain's HOME links the shared store the daemon reads (workload/agent-home.ts).
    const exists = jest.fn(async () => true);
    const shared = unstubbed<RuntimeDeps>("services", { sessions: unstubbed<RuntimeDeps["sessions"]>("sessions", { exists }) });
    try {
        for (const adapter of ADAPTERS) {
            if (adapter.runtime === "acp") {
                // A constant resume hint asks no daemon store/process; its later loop still owns resume placement.
                await expect(adapter.holdsSession(unavailable, "s-1", execution.context)).resolves.toBe(true);
            } else if (adapter.runtime === "claude-code") {
                await expect(adapter.holdsSession(shared, "s-1", execution.context)).resolves.toBe(true);
                expect(exists).toHaveBeenCalledWith(execution.context.cwd, "s-1");
            } else {
                const failed = adapter.holdsSession(unavailable, "s-1", execution.context);
                await expect(failed).rejects.toBeInstanceOf(AgentDomainRefusedError);
                await expect(failed).rejects.toMatchObject({ code: "agent-domain-refused" });
                await expect(failed).rejects.toThrow("does not support unprivileged agent execution yet.");
            }
        }
        expect(cursorSdk).not.toHaveBeenCalled();
        expect(cursorList).not.toHaveBeenCalled();
        expect(piAccess).not.toHaveBeenCalled();
    } finally {
        execution.release();
    }
});

test("Cursor rechecks the execution lease after SDK resolution and before local session listing", async () => {
    const execution = rootExecution({ localCwd: "/work/probe-view" });
    cursorSdk.mockImplementationOnce(async () => {
        execution.release();
        return { Agent: { list: cursorList } };
    });
    try {
        await expect(
            RUNTIME_ADAPTERS.for("cursor", "native").holdsSession(unstubbed<RuntimeDeps>("services", {}), "s-1", execution.context),
        ).rejects.toMatchObject({ code: "agent-domain-refused" });
        expect(cursorList).not.toHaveBeenCalled();
    } finally {
        execution.release();
    }
});

test("root session probes use the issued view cwd rather than a shared workspace default", async () => {
    const execution = rootExecution({ localCwd: "/work/probe-view" });
    const exists = jest.fn(async () => true);
    const sessionExists = jest.fn(async () => true);
    const stores = unstubbed<RuntimeDeps>("services", {
        sessions: unstubbed<RuntimeDeps["sessions"]>("sessions", { exists }),
        openCode: unstubbed<RuntimeDeps["openCode"]>("openCode", { sessionExists }),
    });
    cursorList.mockResolvedValueOnce({ items: [{ agentId: "s-1" }] });
    try {
        for (const provider of ["claude", "grok", "gemini", "cursor"] as const) {
            await expect(RUNTIME_ADAPTERS.for(provider, "native").holdsSession(stores, "s-1", execution.context)).resolves.toBe(true);
        }
        expect(exists).toHaveBeenCalledWith("/work/probe-view", "s-1");
        expect(sessionExists).toHaveBeenCalledTimes(2);
        expect(sessionExists).toHaveBeenCalledWith("s-1", "/work/probe-view");
        expect(cursorList).toHaveBeenCalledWith({ runtime: "local", cwd: "/work/probe-view" });
    } finally {
        execution.release();
    }
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

// Pins invariants the registry's init guard doesn't message precisely: each module serves its own provider, and an
// adapter-less module is backed by another module's runtime.

test("exactly one module per native provider", () => {
    expect(PROVIDER_MODULES.map((module) => module.id).toSorted()).toEqual([...NATIVE_PROVIDERS].toSorted());
});

test("each module's adapters serve runtimes the contract routes to its provider", () => {
    for (const module of PROVIDER_MODULES) {
        const runtimes = new Set([capabilitiesOf(module.id, "native").runtime, capabilitiesOf(module.id, "claude-code").runtime]);
        for (const adapter of module.adapters) {
            expect(runtimes.has(adapter.runtime), `${module.id} contributes ${adapter.runtime}, which never serves it`).toBe(true);
        }
    }
});

test("a module with no adapter is one another module's runtime serves", () => {
    const provided = new Set(PROVIDER_MODULES.flatMap((module) => module.adapters.map((adapter) => adapter.runtime)));
    for (const module of PROVIDER_MODULES.filter((entry) => entry.adapters.length === 0)) {
        for (const harness of ["native", "claude-code"] as const) {
            const runtime = capabilitiesOf(module.id, harness).runtime;
            expect(provided.has(runtime), `${module.id}/${harness} needs ${runtime}, which no module provides`).toBe(true);
        }
    }
});

test("every module carries a catalog and a readiness rung", () => {
    for (const module of PROVIDER_MODULES) {
        expect(typeof module.catalog, module.id).toBe("function");
        expect(typeof module.ready, module.id).toBe("function");
    }
});

test("every minted provider has a generated module, and it contributes no adapter", () => {
    for (const provider of MINTED_PROVIDERS) {
        const module = PROVIDER_MODULES.find((entry) => entry.id === provider);
        expect(module?.id, `${provider} has no module`).toBe(provider);
        expect(module?.adapters, `${provider} contributes an adapter for a runtime it does not own`).toHaveLength(0);
    }
});
