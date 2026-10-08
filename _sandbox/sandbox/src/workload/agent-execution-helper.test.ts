import type { IsolationPlan } from "../conversations/worktrees/isolation.js";
import {
    AgentDomainRefusedError, agentInvocation, assertAgentExecutionContext, createAgentExecutionService,
    requireRootAgentExecution, withAdmittedAgentExecution, withAgentExecution,
    type AgentExecutionAdmission, type AgentExecutionContext, type AgentExecutionService,
} from "./agent-execution.js";
import { rootExecutionService } from "./agent-execution.testing.js";
import { forgetNamespaceEntry, registerAgentDomainEntry, type NamespaceEntryReference } from "./namespace-entry.js";

// Identity/lifetime tests only: the namespace registry uses fake PIDs, never processes or kernel namespace handles.
const VIEW = "/pure-helper-view";
const references: NamespaceEntryReference[] = [];
afterEach(() => { for (const ref of references.splice(0)) { forgetNamespaceEntry(ref); } });
const domainFixture = async () => {
    const service = createAgentExecutionService(async () => ({ agentDomain: "unprivileged" }), () => {});
    const admission = await service.admit();
    const namespace = registerAgentDomainEntry(62801, { userNamespace: "/proc/62802/ns/user", home: "/home/agent" });
    references.push(namespace);
    const plan: IsolationPlan = { root: VIEW, worktree: "/pure-helper-local", mirrors: [], overlays: "/pure-helper-overlays", fence: undefined };
    const dispose = jest.fn(() => forgetNamespaceEntry(namespace));
    const placement = { localCwd: plan.worktree, isolation: { plan, anchor: { pid: namespace.pid, namespace, cwd: VIEW, plan, dispose } } };
    return { service, admission, namespace, placement, dispose };
};
const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
};

test.each(["forged", "released"] as const)("helper and root-only validators refuse %s authority", async (kind) => {
    const service = rootExecutionService();
    const admission = await service.admit();
    const lease = service.acquire(admission, { localCwd: VIEW });
    const context: AgentExecutionContext = kind === "forged" ? { mode: "root", cwd: VIEW } : lease.context;
    if (kind === "released") { lease.release(); }
    try {
        for (const validate of [() => assertAgentExecutionContext(context), () => requireRootAgentExecution(context, "shared helper")]) {
            expect(validate).toThrow(AgentDomainRefusedError);
            expect(validate).toThrow("Agent execution context is not registered or has been released.");
        }
    } finally { lease.release(); service.close(admission); }
});

test("validators check a genuine domain generation, not only context liveness", async () => {
    const fixture = await domainFixture();
    const lease = fixture.service.acquire(fixture.admission, fixture.placement);
    try {
        expect(() => assertAgentExecutionContext(lease.context)).not.toThrow();
        expect(() => requireRootAgentExecution(lease.context, "shared helper")).toThrow("shared helper does not support unprivileged agent execution yet.");
        forgetNamespaceEntry(fixture.namespace);
        expect(() => assertAgentExecutionContext(lease.context)).toThrow("namespace anchor 62801 reference is not registered");
        expect(() => requireRootAgentExecution(lease.context, "shared helper")).toThrow("namespace anchor 62801 reference is not registered");
    } finally { lease.release(); fixture.service.close(fixture.admission); }
});

test("helper validation accepts contained clean cwd and refuses escapes in both validators", async () => {
    const service = rootExecutionService();
    const admission = await service.admit();
    const lease = service.acquire(admission, { localCwd: VIEW });
    try {
        expect(() => assertAgentExecutionContext(lease.context, `${VIEW}/child`)).not.toThrow();
        expect(() => requireRootAgentExecution(lease.context, "shared helper", `${VIEW}/child`)).not.toThrow();
        for (const validate of [assertAgentExecutionContext, (context: AgentExecutionContext, cwd: string) => requireRootAgentExecution(context, "shared helper", cwd)]) {
            expect(() => validate(lease.context, "/other-view")).toThrow("Agent execution cwd does not belong to the admitted view.");
            expect(() => validate(lease.context, `${VIEW}/../other-view`)).toThrow("Agent execution requires an absolute, clean working directory.");
        }
    } finally { lease.release(); service.close(admission); }
});

test.each(["answer", "reject"] as const)("detached admitted helper acquires before dispatch and survives admission closure until its own %s", async (ending) => {
    const fixture = await domainFixture();
    const done = deferred<void>();
    const contexts: AgentExecutionContext[] = [];
    const failure = new Error("synthetic detached helper failure");
    const pending = withAdmittedAgentExecution(fixture.service, fixture.admission, fixture.placement, async (context) => {
        contexts.push(context);
        await done.promise;
        assertAgentExecutionContext(context);
        if (ending === "reject") { throw failure; }
        return "named";
    });
    // No await preceded acquisition/dispatch: parent placement may start and admission may close immediately.
    expect(contexts).toHaveLength(1);
    const context = contexts[0]!;
    fixture.service.close(fixture.admission);
    expect(() => assertAgentExecutionContext(context)).not.toThrow();
    expect(fixture.dispose).not.toHaveBeenCalled();
    expect(() => fixture.service.acquire(fixture.admission, fixture.placement)).toThrow("Agent execution admission is not registered or has been closed.");
    done.resolve();
    if (ending === "reject") { await expect(pending).rejects.toBe(failure); }
    else { await expect(pending).resolves.toBe("named"); }
    expect(fixture.dispose).toHaveBeenCalledTimes(1);
    expect(() => agentInvocation(context, "helper", [])).toThrow("Agent execution context is not registered or has been released.");
});

test("an admitted helper cleans its proposed anchor when acquisition refuses and never dispatches", async () => {
    const fixture = await domainFixture();
    const use = jest.fn(async () => "not dispatched");
    fixture.service.close(fixture.admission);
    await expect(withAdmittedAgentExecution(fixture.service, fixture.admission, fixture.placement, use)).rejects.toMatchObject({
        code: "agent-domain-refused", message: "Agent execution admission is not registered or has been closed.",
    });
    expect(use).not.toHaveBeenCalled();
    expect(fixture.dispose).toHaveBeenCalledTimes(1);
});

test.each(["answer", "reject", "sync throw"] as const)("standalone helper owns protected admission and cleanup on %s", async (ending) => {
    const issuer = rootExecutionService();
    const contexts: AgentExecutionContext[] = [];
    const admissions: AgentExecutionAdmission[] = [];
    const lifecycle: string[] = [];
    const service: AgentExecutionService = {
        admit: async () => { lifecycle.push("admit"); const admission = await issuer.admit(); admissions.push(admission); return admission; },
        acquire: (admission, placement) => {
            lifecycle.push("acquire");
            const lease = issuer.acquire(admission, placement);
            contexts.push(lease.context);
            return { context: lease.context, release: () => { lifecycle.push("release"); lease.release(); } };
        },
        close: (admission) => { lifecycle.push("close"); issuer.close(admission); },
        borrow: issuer.borrow,
    };
    const failure = new Error("standalone helper refused");
    const use = (context: AgentExecutionContext): Promise<string> => {
        lifecycle.push("dispatch");
        expect(context).toBe(contexts[0]!);
        expect(agentInvocation(context, "helper", [])).toEqual({ command: "helper", args: [], cwd: VIEW });
        if (ending === "sync throw") { throw failure; }
        return ending === "reject" ? Promise.reject(failure) : Promise.resolve("answer");
    };
    const pending = withAgentExecution(service, { localCwd: VIEW }, use);
    if (ending === "answer") { await expect(pending).resolves.toBe("answer"); }
    else { await expect(pending).rejects.toBe(failure); }
    expect(lifecycle).toEqual(["admit", "acquire", "dispatch", "release", "close"]);
    expect(() => assertAgentExecutionContext(contexts[0]!)).toThrow("Agent execution context is not registered or has been released.");
    expect(() => issuer.acquire(admissions[0]!, { localCwd: VIEW })).toThrow("Agent execution admission is not registered or has been closed.");
});

test("a standalone helper does not downgrade a protected unprivileged policy to root", async () => {
    const use = jest.fn(async () => "not dispatched");
    const service = createAgentExecutionService(async () => ({ agentDomain: "unprivileged" }));
    await expect(withAgentExecution(service, { localCwd: VIEW }, use)).rejects.toMatchObject({ code: "agent-domain-refused" });
    expect(use).not.toHaveBeenCalled();
});

test("an unprivileged admission cannot authorize a plain helper workspace placement even with a pure rollout override", async () => {
    const fixture = await domainFixture();
    const use = jest.fn(async () => "not dispatched");
    await expect(withAdmittedAgentExecution(fixture.service, fixture.admission, { localCwd: VIEW }, use)).rejects.toMatchObject({
        code: "agent-domain-refused", message: "Unprivileged execution requires an issued domain namespace reference.",
    });
    expect(use).not.toHaveBeenCalled();
    fixture.service.close(fixture.admission);
});
