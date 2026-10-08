import type { AgentDomainPolicy, AgentEvent } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import type { IsolationPlan } from "../../conversations/worktrees/isolation.js";
import {
    AgentDomainRefusedError, assertAgentExecution, assertAgentExecutionContext, createAgentExecutionService,
    type AgentExecutionContext,
} from "../../workload/agent-execution.js";
import { forgetNamespaceEntry, registerMountEntry, type NamespaceEntryReference } from "../../workload/namespace-entry.js";
import type { HarnessRequest } from "../../agent/run/agent.js";
import { claudeKeepable, type ClaudeWarmDeps } from "./claude-warm.js";

// Pure refresh ownership. Anchors are issued registry references with fake PIDs; no namespace/process/file API runs.
const VIEW = "/pure-cache-view";
const references: NamespaceEntryReference[] = [];
afterEach(() => { for (const reference of references.splice(0)) { forgetNamespaceEntry(reference); } });
const fixture = async (options: {
    readonly runtime?: ClaudeWarmDeps["agent"];
    readonly staleAnchor?: boolean;
} = {}) => {
    let policy: AgentDomainPolicy = { agentDomain: "root" };
    const service = createAgentExecutionService(async () => policy);
    const admission = await service.admit();
    const oldNamespace = registerMountEntry(62820);
    references.push(oldNamespace);
    const plan: IsolationPlan = { root: VIEW, worktree: "/pure-cache-local", mirrors: [], overlays: "/pure-cache-overlays", fence: undefined };
    const oldDispose = jest.fn(() => forgetNamespaceEntry(oldNamespace));
    const oldAnchor = { pid: oldNamespace.pid, namespace: oldNamespace, cwd: VIEW, plan, dispose: oldDispose };
    const oldLease = service.acquire(admission, { localCwd: plan.worktree, isolation: { plan, anchor: oldAnchor } });
    const request: HarnessRequest = {
        execution: oldLease.context,
        spec: { cwd: VIEW, prompt: "old words", model: "unchanged-model", isolation: { plan, anchor: oldAnchor } },
        policy: {}, tools: {}, hooks: { cards: unstubbed("cards", {}) },
        credential: { kind: "claude-oauth", token: "synthetic-old-token" }, signal: new AbortController().signal,
    };
    const contexts: AgentExecutionContext[] = [];
    const finalized: AgentExecutionContext[] = [];
    const read = jest.fn(async () => ({ id: "synthetic-account", label: "synthetic account", connectedAt: 0, accessToken: "synthetic-fresh-token" }));
    const agent: ClaudeWarmDeps["agent"] = options.runtime ?? (async function* (refresh) {
        contexts.push(refresh.execution);
        assertAgentExecution(refresh.execution, refresh.spec);
        try {
            yield { kind: "delta", text: "ok" };
            yield { kind: "done" };
        } finally {
            assertAgentExecution(refresh.execution, refresh.spec);
            finalized.push(refresh.execution);
        }
    });
    const deps = unstubbed<ClaudeWarmDeps>("warm", {
        agentExecution: service, agent,
        claudeStore: unstubbed<ClaudeWarmDeps["claudeStore"]>("claudeStore", { read }),
    });
    const dispose = jest.fn();
    const anchor = jest.fn(async () => {
        const namespace = registerMountEntry(62821);
        references.push(namespace);
        dispose.mockImplementation(() => forgetNamespaceEntry(namespace));
        if (options.staleAnchor) { forgetNamespaceEntry(namespace); }
        return { pid: namespace.pid, namespace, cwd: VIEW, plan, dispose };
    });
    const replay = claudeKeepable(deps, { request, account: "synthetic-account", sessionId: "synthetic-session", anchor });
    if (replay === undefined) { throw new Error("the synthetic subscription request must be keepable"); }
    oldLease.release();
    service.close(admission);
    return { deps, service, request, replay, oldDispose, dispose, contexts, finalized, read, anchor, setPolicy: (next: AgentDomainPolicy) => { policy = next; } };
};

const collect = async (frames: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> => {
    const result: AgentEvent[] = [];
    for await (const event of frames) { result.push(event); }
    return result;
};

test.each(["complete", "return"] as const)("a cache refresh owns fresh authority through runtime finalization on %s", async (ending) => {
    const turn = await fixture();
    expect(() => assertAgentExecutionContext(turn.request.execution)).toThrow("Agent execution context is not registered or has been released.");
    expect(turn.oldDispose).toHaveBeenCalledTimes(1);
    const frames = turn.replay.send(new AbortController().signal)[Symbol.asyncIterator]();
    try {
        expect(await frames.next()).toEqual({ done: false, value: { kind: "delta", text: "ok" } });
        const context = turn.contexts[0]!;
        expect(context).not.toBe(turn.request.execution);
        expect(() => assertAgentExecutionContext(context)).not.toThrow();
        expect(turn.dispose).not.toHaveBeenCalled();
        if (ending === "return") { await frames.return?.(); }
        else {
            expect(await frames.next()).toEqual({ done: false, value: { kind: "done" } });
            expect(() => assertAgentExecutionContext(context)).not.toThrow();
            expect(await frames.next()).toEqual({ done: true, value: undefined });
        }
        expect(turn.finalized).toEqual([context]);
        expect(turn.dispose).toHaveBeenCalledTimes(1);
        expect(() => assertAgentExecutionContext(context)).toThrow("Agent execution context is not registered or has been released.");
        expect(turn.anchor).toHaveBeenCalledTimes(1);
    } finally { await frames.return?.(); }
});

test("a synchronous refresh runtime factory failure still releases its new placement", async () => {
    const failure = new Error("synthetic refresh runtime construction failure");
    const contexts: AgentExecutionContext[] = [];
    const turn = await fixture({ runtime: (request) => { assertAgentExecution(request.execution, request.spec); contexts.push(request.execution); throw failure; } });
    await expect(collect(turn.replay.send(new AbortController().signal))).rejects.toBe(failure);
    expect(turn.dispose).toHaveBeenCalledTimes(1);
    expect(contexts).toHaveLength(1);
    expect(() => assertAgentExecutionContext(contexts[0]!)).toThrow("Agent execution context is not registered or has been released.");
});

test("a refresh acquisition refusal cleans its own anchor and never dispatches the runtime", async () => {
    const turn = await fixture({ staleAnchor: true });
    await expect(collect(turn.replay.send(new AbortController().signal))).rejects.toMatchObject({ code: "agent-domain-refused" });
    expect(turn.dispose).toHaveBeenCalledTimes(1);
    expect(turn.contexts).toEqual([]);
    expect(turn.anchor).toHaveBeenCalledTimes(1);
});

test("a changed protected policy refuses refresh before credential reads, root anchor creation or runtime", async () => {
    const turn = await fixture();
    turn.setPolicy({ agentDomain: "unprivileged" });
    await expect(collect(turn.replay.send(new AbortController().signal))).rejects.toBeInstanceOf(AgentDomainRefusedError);
    expect(turn.read).not.toHaveBeenCalled();
    expect(turn.anchor).not.toHaveBeenCalled();
    expect(turn.contexts).toEqual([]);
    expect(turn.dispose).not.toHaveBeenCalled();
});

test("a captured replay never makes its released original request a new authority", async () => {
    const turn = await fixture();
    expect(() => claudeKeepable(turn.deps, { request: turn.request, account: "synthetic-account", sessionId: "synthetic-session", anchor: turn.anchor }))
        .toThrow("Agent execution context is not registered or has been released.");
    expect(turn.anchor).not.toHaveBeenCalled();
    expect(turn.read).not.toHaveBeenCalled();
});

test.each(["forged", "changed cwd"] as const)("replay capture refuses %s authority before storing a recipe", async (kind) => {
    const service = createAgentExecutionService(async () => ({ agentDomain: "root" }));
    const admission = await service.admit();
    const lease = service.acquire(admission, { localCwd: VIEW });
    const request: HarnessRequest = {
        execution: kind === "forged" ? { mode: "root", cwd: VIEW } : lease.context,
        spec: { cwd: kind === "changed cwd" ? `${VIEW}/child` : VIEW, prompt: "old words" },
        policy: {}, tools: {}, hooks: { cards: unstubbed("cards", {}) },
        credential: { kind: "claude-oauth", token: "synthetic-token" }, signal: new AbortController().signal,
    };
    const deps = unstubbed<ClaudeWarmDeps>("warm", {});
    const anchor = jest.fn<Parameters<typeof claudeKeepable>[1]["anchor"]>();
    try {
        expect(() => claudeKeepable(deps, { request, account: "synthetic-account", sessionId: "synthetic-session", anchor }))
            .toThrow(kind === "forged" ? "Agent execution context is not registered or has been released." : "Agent request placement does not match its admitted execution context.");
        expect(anchor).not.toHaveBeenCalled();
    } finally { lease.release(); service.close(admission); }
});
