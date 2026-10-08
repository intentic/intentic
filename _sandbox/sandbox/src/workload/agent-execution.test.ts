import type { AgentDomainPolicy } from "@intentic/sandbox-contract";
import type { FencedPlacement, IsolationPlan } from "../conversations/worktrees/isolation.js";
import { AGENT_DOMAIN_NOT_READY } from "./agent-domain-rollout.js";
import {
    AgentDomainRefusedError, agentExecutionScope, agentInvocation, assertAgentExecution, createAgentExecutionService,
    type AgentExecutionContext,
} from "./agent-execution.js";
import { rootExecutionService } from "./agent-execution.testing.js";
import {
    agentEntrant, forgetNamespaceEntry, registerAgentDomainEntry, registerMountEntry, registerSandboxEntry,
    type AgentDomainEntry, type NamespaceEntryReference,
} from "./namespace-entry.js";

// Pure coordination only: fake PIDs identify real registry objects, never processes or kernel namespaces.
// The local rollout override permits entrant construction, not a live launch or production policy activation.
const unprivilegedExecutionService = () => createAgentExecutionService(async () => ({ agentDomain: "unprivileged" }), () => {});
const VIEW = "/work/project";
const LOCAL = "/history/worktrees/project";
const COMMAND = "node";
const ARGS = ["--", "an argument"];
const DOMAIN: AgentDomainEntry = { userNamespace: "/proc/62300/ns/user", home: "/home/agent" };
const FENCE: FencedPlacement = { folders: ["apps/web"], hidden: [], sessions: "/history/sessions/project", gitPointers: [""] };

const references: NamespaceEntryReference[] = [];
const tracked = (reference: NamespaceEntryReference): NamespaceEntryReference => {
    references.push(reference);
    return reference;
};
afterEach(() => {
    for (const reference of references.splice(0)) { forgetNamespaceEntry(reference); }
});

const anchored = (pid: number, namespace?: NamespaceEntryReference, fence?: FencedPlacement) => {
    const plan: IsolationPlan = { root: VIEW, worktree: LOCAL, mirrors: [], overlays: "/history/overlays/project", fence };
    const dispose = jest.fn(() => { if (namespace !== undefined) { forgetNamespaceEntry(namespace); } });
    const anchor = { pid, cwd: VIEW, plan, ...(namespace === undefined ? {} : { namespace }), dispose };
    return { anchor, dispose, placement: { localCwd: LOCAL, isolation: { plan, anchor } } };
};

const expectRefused = (action: () => unknown, message: string): void => {
    let thrown: unknown;
    try { action(); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(AgentDomainRefusedError);
    if (!(thrown instanceof AgentDomainRefusedError)) { throw new Error("Expected an agent execution refusal", { cause: thrown }); }
    expect({ name: thrown.name, code: thrown.code, message: thrown.message }).toEqual({
        name: "AgentDomainRefusedError", code: "agent-domain-refused", message,
    });
};
const CONTEXT_REFUSED = "Agent execution context is not registered or has been released.";
const ADMISSION_REFUSED = "Agent execution admission is not registered or has been closed.";
const SCOPE_REFUSED = "Agent execution preparation scope is closed or already acquired.";
const PLACEMENT_REFUSED = "Agent request placement does not match its admitted execution context.";
const CLEAN_CWD_REFUSED = "Agent execution requires an absolute, clean working directory.";
const DOMAIN_REFERENCE_REQUIRED = "Unprivileged execution requires an issued domain namespace reference.";

const mountInvocation = (pid: number, cwd = VIEW) => ({ command: "nsenter", args: [
    `--mount=/proc/${String(pid)}/ns/mnt`, `--wdns=${cwd}`, "--", "env", "-u", "PWD", "-u", "OLDPWD", COMMAND, ...ARGS,
] });
const domainInvocation = (pid: number, cwd = VIEW, entry = DOMAIN) => ({ command: "nsenter", args: [
    `--target=${String(pid)}`, `--user=${entry.userNamespace}`, "--mount", "--pid", "--setuid=0", "--setgid=0",
    `--wdns=${cwd}`, "--", "setpriv", "--no-new-privs", "env", "-u", "PWD", "-u", "OLDPWD",
    `HOME=${entry.home}`, "USER=agent", "LOGNAME=agent", "XDG_RUNTIME_DIR=/run/user/0", COMMAND, ...ARGS,
] });

test("the default rollout refuses unprivileged admission rather than issuing a root handle", async () => {
    const readProtectedPolicy = jest.fn(async (): Promise<AgentDomainPolicy> => ({ agentDomain: "unprivileged" }));
    const service = createAgentExecutionService(readProtectedPolicy);
    const admission = service.admit();
    await expect(admission).rejects.toBeInstanceOf(AgentDomainRefusedError);
    await expect(admission).rejects.toMatchObject({ code: "agent-domain-refused", message: AGENT_DOMAIN_NOT_READY });
    expect(readProtectedPolicy).toHaveBeenCalledTimes(1);
    expectRefused(() => service.acquire({ mode: "root" }, { localCwd: VIEW }), ADMISSION_REFUSED);
});

test("an unreadable protected policy refuses with its cause instead of defaulting to root", async () => {
    const cause = new Error("protected policy is corrupt");
    const rollout = jest.fn();
    const service = createAgentExecutionService(async () => { throw cause; }, rollout);
    const admission = service.admit();
    await expect(admission).rejects.toBeInstanceOf(AgentDomainRefusedError);
    await expect(admission).rejects.toMatchObject({ code: "agent-domain-refused", message: cause.message, cause });
    expect(rollout).not.toHaveBeenCalled();
    expectRefused(() => service.acquire({ mode: "root" }, { localCwd: VIEW }), ADMISSION_REFUSED);
});

test("an explicit protected root admission retains direct invocation compatibility", async () => {
    const service = rootExecutionService();
    const admission = await service.admit();
    const lease = service.acquire(admission, { localCwd: VIEW });
    try {
        expect(admission).toEqual({ mode: "root" });
        expect(lease.context).toEqual({ mode: "root", cwd: VIEW });
        expect(Object.isFrozen(admission)).toBe(true);
        expect(Object.isFrozen(lease)).toBe(true);
        expect(Object.isFrozen(lease.context)).toBe(true);
        const invocation = agentInvocation(lease.context, COMMAND, ARGS);
        expect(invocation).toEqual({ command: COMMAND, args: ARGS, cwd: VIEW });
        expect(invocation.args).not.toBe(ARGS);
        expect(() => assertAgentExecution(lease.context, { cwd: VIEW })).not.toThrow();
    } finally { lease.release(); service.close(admission); }
});

test.each(["numeric", "issued"] as const)("root mount placement retains exact argv with an %s target", async (kind) => {
    const service = rootExecutionService();
    const admission = await service.admit();
    const namespace = tracked(registerMountEntry(62201));
    const fixture = anchored(namespace.pid, kind === "issued" ? namespace : undefined);
    const lease = service.acquire(admission, fixture.placement);
    try {
        expect(lease.context).toEqual({ mode: "root", cwd: VIEW });
        expect(agentInvocation(lease.context, COMMAND, ARGS)).toEqual(mountInvocation(namespace.pid));
        expect(() => assertAgentExecution(lease.context, { cwd: VIEW, isolation: fixture.placement.isolation })).not.toThrow();
        expect(fixture.dispose).not.toHaveBeenCalled();
        lease.release();
        lease.release();
        expect(fixture.dispose).toHaveBeenCalledTimes(1);
    } finally { lease.release(); service.close(admission); }
});

test.each(["numeric", "issued"] as const)("root fenced placement retains exact argv with an %s target", async (kind) => {
    const service = rootExecutionService();
    const admission = await service.admit();
    const namespace = tracked(registerSandboxEntry(62202, { uid: 1000, gid: 1001 }));
    const fixture = anchored(namespace.pid, kind === "issued" ? namespace : undefined, FENCE);
    const lease = service.acquire(admission, fixture.placement);
    try {
        expect(agentInvocation(lease.context, COMMAND, ARGS)).toEqual({ command: "nsenter", args: [
            "--target=62202", "--user", "--mount", "--pid", "--uts", "--ipc", "--setuid=1000", "--setgid=1001",
            `--wdns=${VIEW}`, "--", "setpriv", "--no-new-privs", "env", "-u", "PWD", "-u", "OLDPWD", COMMAND, ...ARGS,
        ] });
        expect(() => assertAgentExecution(lease.context, { cwd: VIEW, isolation: fixture.placement.isolation })).not.toThrow();
    } finally { lease.release(); service.close(admission); }
    expect(fixture.dispose).toHaveBeenCalledTimes(1);
});

test("a root plan without an anchor invokes directly but still binds the request's plan identity", async () => {
    const service = rootExecutionService();
    const admission = await service.admit();
    const { plan } = anchored(62203).placement.isolation;
    const isolation = { plan };
    const lease = service.acquire(admission, { localCwd: LOCAL, isolation });
    try {
        expect(agentInvocation(lease.context, COMMAND, ARGS)).toEqual({ command: COMMAND, args: ARGS, cwd: LOCAL });
        expect(() => assertAgentExecution(lease.context, { cwd: LOCAL, isolation: { plan } })).not.toThrow();
        expectRefused(() => assertAgentExecution(lease.context, { cwd: LOCAL }), PLACEMENT_REFUSED);
        expectRefused(() => assertAgentExecution(lease.context, { cwd: LOCAL, isolation: { plan: { ...plan } } }), PLACEMENT_REFUSED);
    } finally { lease.release(); service.close(admission); }
});

test.each(["forged", "foreign", "closed"] as const)("%s admissions cannot acquire a placement", async (kind) => {
    const service = rootExecutionService();
    const other = rootExecutionService();
    const own = await service.admit();
    const foreign = await other.admit();
    const admission = kind === "forged" ? { ...own } : kind === "foreign" ? foreign : own;
    const fixture = anchored(62204);
    if (kind === "closed") { service.close(own); service.close(own); }
    try {
        expect(admission).toEqual({ mode: "root" });
        expectRefused(() => service.acquire(admission, fixture.placement), ADMISSION_REFUSED);
        expect(fixture.dispose).not.toHaveBeenCalled();
    } finally { service.close(own); other.close(foreign); }
});

test("closing admissions is identity-local and does not revoke already acquired contexts", async () => {
    const service = rootExecutionService();
    const other = rootExecutionService();
    const admission = await service.admit();
    const foreign = await other.admit();
    service.close({ ...admission });
    other.close(admission);
    service.close(foreign);
    const lease = service.acquire(admission, { localCwd: VIEW });
    service.close(admission);
    const borrower = service.borrow(lease.context);
    try {
        expectRefused(() => service.acquire(admission, { localCwd: VIEW }), ADMISSION_REFUSED);
        expect(agentInvocation(lease.context, COMMAND, ARGS)).toEqual({ command: COMMAND, args: ARGS, cwd: VIEW });
        expect(agentInvocation(borrower.context, COMMAND, ARGS)).toEqual({ command: COMMAND, args: ARGS, cwd: VIEW });
        const foreignLease = other.acquire(foreign, { localCwd: VIEW });
        foreignLease.release();
    } finally { lease.release(); borrower.release(); other.close(foreign); }
});

test.each(["forged", "released"] as const)("%s execution contexts cannot invoke, validate a request, or borrow", async (kind) => {
    const service = rootExecutionService();
    const admission = await service.admit();
    const lease = service.acquire(admission, { localCwd: VIEW });
    const context: AgentExecutionContext = kind === "forged" ? { ...lease.context } : lease.context;
    if (kind === "released") { lease.release(); }
    try {
        expect(context).toEqual({ mode: "root", cwd: VIEW });
        expectRefused(() => agentInvocation(context, COMMAND, ARGS), CONTEXT_REFUSED);
        expectRefused(() => assertAgentExecution(context, { cwd: VIEW }), CONTEXT_REFUSED);
        expectRefused(() => service.borrow(context), CONTEXT_REFUSED);
    } finally { lease.release(); service.close(admission); }
});

test("another coordinator cannot borrow a valid context merely because its fields match", async () => {
    const service = rootExecutionService();
    const other = rootExecutionService();
    const admission = await service.admit();
    const lease = service.acquire(admission, { localCwd: VIEW });
    try {
        expectRefused(() => other.borrow(lease.context), "Agent execution context belongs to a different daemon coordinator.");
        expect(agentInvocation(lease.context, COMMAND, ARGS)).toEqual({ command: COMMAND, args: ARGS, cwd: VIEW });
    } finally { lease.release(); service.close(admission); }
});

test.each(["no placement", "plan without anchor"] as const)("unprivileged admission refuses %s", async (kind) => {
    const service = unprivilegedExecutionService();
    const admission = await service.admit();
    const { plan } = anchored(62205).placement.isolation;
    try {
        const placement = kind === "no placement" ? { localCwd: LOCAL } : { localCwd: LOCAL, isolation: { plan } };
        expectRefused(() => service.acquire(admission, placement), DOMAIN_REFERENCE_REQUIRED);
    } finally { service.close(admission); }
});

test("a live domain registered under a numeric PID cannot replace its issued reference", async () => {
    const service = unprivilegedExecutionService();
    const admission = await service.admit();
    const namespace = tracked(registerAgentDomainEntry(62206, DOMAIN));
    const fixture = anchored(namespace.pid);
    try {
        expectRefused(() => service.acquire(admission, fixture.placement), DOMAIN_REFERENCE_REQUIRED);
        expect(fixture.dispose).not.toHaveBeenCalled();
        expect(agentEntrant(namespace, VIEW, COMMAND, ARGS)).toEqual(domainInvocation(namespace.pid));
    } finally { service.close(admission); }
});

test.each(["mount", "sandbox", "reconstructed", "stale"] as const)("unprivileged admission refuses a %s namespace reference", async (kind) => {
    const service = unprivilegedExecutionService();
    const admission = await service.admit();
    const issued = tracked(kind === "mount" ? registerMountEntry(62207)
        : kind === "sandbox" ? registerSandboxEntry(62207, { uid: 1000, gid: 1001 }) : registerAgentDomainEntry(62207, DOMAIN));
    if (kind === "stale") { forgetNamespaceEntry(issued); }
    const namespace = kind === "reconstructed" ? { ...issued } : issued;
    const fixture = anchored(issued.pid, namespace);
    try {
        const message = kind === "mount" || kind === "sandbox" ? "agent domain anchor 62207 is not registered" : "namespace anchor 62207 reference is not registered";
        expectRefused(() => service.acquire(admission, fixture.placement), message);
        expect(fixture.dispose).not.toHaveBeenCalled();
    } finally { service.close(admission); }
});

test("placement PID and issued namespace reference must agree before acquisition", async () => {
    const service = unprivilegedExecutionService();
    const admission = await service.admit();
    const namespace = tracked(registerAgentDomainEntry(62208, DOMAIN));
    const fixture = anchored(62209, namespace);
    try {
        expectRefused(() => service.acquire(admission, fixture.placement), "Agent placement and namespace reference do not identify the same anchor.");
        expect(fixture.dispose).not.toHaveBeenCalled();
    } finally { service.close(admission); }
});

test("even an issued domain reference cannot admit unsupported fenced-domain composition", async () => {
    const service = unprivilegedExecutionService();
    const admission = await service.admit();
    const namespace = tracked(registerAgentDomainEntry(62210, DOMAIN));
    const fixture = anchored(namespace.pid, namespace, FENCE);
    try {
        expectRefused(() => service.acquire(admission, fixture.placement), "Unprivileged execution does not yet support fenced-domain composition.");
        expect(fixture.dispose).not.toHaveBeenCalled();
    } finally { service.close(admission); }
});

test("same-PID domain replacement cannot revive a context or let its old disposer retire the new generation", async () => {
    const service = unprivilegedExecutionService();
    const admission = await service.admit();
    const old = tracked(registerAgentDomainEntry(62211, DOMAIN));
    const original = anchored(old.pid, old);
    const lease = service.acquire(admission, original.placement);
    forgetNamespaceEntry(old);
    const entry = { userNamespace: "/proc/62301/ns/user", home: "/home/replacement" };
    const fresh = tracked(registerAgentDomainEntry(old.pid, entry));
    const replacement = anchored(fresh.pid, fresh);
    const next = service.acquire(admission, replacement.placement);
    try {
        const message = "namespace anchor 62211 reference is not registered";
        expectRefused(() => agentInvocation(lease.context, COMMAND, ARGS), message);
        expectRefused(() => assertAgentExecution(lease.context, { cwd: VIEW, isolation: original.placement.isolation }), message);
        expectRefused(() => service.borrow(lease.context), message);
        expectRefused(() => service.acquire(admission, original.placement), message);
        expectRefused(() => service.acquire(admission, anchored(fresh.pid, { ...fresh }).placement), message);
        lease.release();
        expect(original.dispose).toHaveBeenCalledTimes(1);
        expect(agentInvocation(next.context, COMMAND, ARGS)).toEqual(domainInvocation(fresh.pid, VIEW, entry));
        expect(replacement.dispose).not.toHaveBeenCalled();
    } finally { lease.release(); next.release(); service.close(admission); }
});

test("root PID reuse requires a fresh issued generation without reviving domain or numeric compatibility", async () => {
    const root = rootExecutionService();
    const unprivileged = unprivilegedExecutionService();
    const rootAdmission = await root.admit();
    const domainAdmission = await unprivileged.admit();
    const old = tracked(registerAgentDomainEntry(62212, DOMAIN));
    forgetNamespaceEntry(old);
    const fresh = tracked(registerMountEntry(old.pid));
    const lease = root.acquire(rootAdmission, anchored(fresh.pid, fresh).placement);
    try {
        expect(agentInvocation(lease.context, COMMAND, ARGS)).toEqual(mountInvocation(fresh.pid));
        expectRefused(() => root.acquire(rootAdmission, anchored(fresh.pid).placement), "agent domain anchor 62212 is not registered");
        expectRefused(() => unprivileged.acquire(domainAdmission, anchored(old.pid, old).placement), "namespace anchor 62212 reference is not registered");
        expectRefused(() => unprivileged.acquire(domainAdmission, anchored(fresh.pid, fresh).placement), "agent domain anchor 62212 is not registered");
    } finally { lease.release(); root.close(rootAdmission); unprivileged.close(domainAdmission); }
});

const uncleanCwds = ["", "work/project", "/work/./project", "/work/other/../project", "/work//project", `${VIEW}\u0000`, `${VIEW}\n`, `${VIEW}\u007f`];
test.each(uncleanCwds)("acquisition rejects an unclean local cwd %j", async (localCwd) => {
    const service = rootExecutionService();
    const admission = await service.admit();
    try { expectRefused(() => service.acquire(admission, { localCwd }), CLEAN_CWD_REFUSED); }
    finally { service.close(admission); }
});

test.each(["local", "anchor"] as const)("anchored acquisition still validates its %s cwd", async (kind) => {
    const service = rootExecutionService();
    const admission = await service.admit();
    const namespace = tracked(registerMountEntry(62213));
    const fixture = anchored(namespace.pid, namespace);
    if (kind === "local") { fixture.placement.localCwd = "relative/worktree"; }
    else { fixture.anchor.cwd = "/work/../project"; }
    try {
        expectRefused(() => service.acquire(admission, fixture.placement), CLEAN_CWD_REFUSED);
        expect(fixture.dispose).not.toHaveBeenCalled();
    } finally { service.close(admission); }
});

test("direct invocation permits the admitted root and descendants, not parents or prefix siblings", async () => {
    const service = rootExecutionService();
    const admission = await service.admit();
    const lease = service.acquire(admission, { localCwd: VIEW });
    try {
        for (const cwd of [VIEW, `${VIEW}/src`, `${VIEW}/src/nested`]) {
            expect(agentInvocation(lease.context, COMMAND, ARGS, cwd)).toEqual({ command: COMMAND, args: ARGS, cwd });
        }
        for (const cwd of ["/work", "/", "/work/project-other", "/history/worktrees/project"]) {
            expectRefused(() => agentInvocation(lease.context, COMMAND, ARGS, cwd), "Agent execution cwd does not belong to the admitted view.");
        }
        for (const cwd of uncleanCwds) { expectRefused(() => agentInvocation(lease.context, COMMAND, ARGS, cwd), CLEAN_CWD_REFUSED); }
    } finally { lease.release(); service.close(admission); }
});

test("domain cwd containment uses the admitted namespace view, never the daemon worktree", async () => {
    const service = unprivilegedExecutionService();
    const admission = await service.admit();
    const namespace = tracked(registerAgentDomainEntry(62214, DOMAIN));
    const fixture = anchored(namespace.pid, namespace);
    const lease = service.acquire(admission, fixture.placement);
    try {
        expect(lease.context).toEqual({ mode: "unprivileged", cwd: VIEW });
        expect(agentInvocation(lease.context, COMMAND, ARGS)).toEqual(domainInvocation(namespace.pid));
        expect(agentInvocation(lease.context, COMMAND, ARGS, `${VIEW}/src`)).toEqual(domainInvocation(namespace.pid, `${VIEW}/src`));
        expectRefused(() => agentInvocation(lease.context, COMMAND, ARGS, LOCAL), "Agent execution cwd does not belong to the admitted view.");
        expectRefused(() => agentInvocation(lease.context, COMMAND, ARGS, "/work/project-other"), "Agent execution cwd does not belong to the admitted view.");
    } finally { lease.release(); service.close(admission); }
});

test.each(["cwd", "removed isolation", "plan", "anchor"] as const)("request validation refuses a replaced %s", async (kind) => {
    const service = rootExecutionService();
    const admission = await service.admit();
    const namespace = tracked(registerMountEntry(62215));
    const fixture = anchored(namespace.pid, namespace);
    const isolation = fixture.placement.isolation;
    const lease = service.acquire(admission, fixture.placement);
    try {
        expect(() => assertAgentExecution(lease.context, { cwd: VIEW, isolation: { ...isolation } })).not.toThrow();
        const replacement = kind === "cwd" ? { cwd: `${VIEW}/src`, isolation }
            : kind === "removed isolation" ? { cwd: VIEW }
                : { cwd: VIEW, isolation: kind === "plan" ? { ...isolation, plan: { ...isolation.plan } } : { ...isolation, anchor: { ...isolation.anchor } } };
        expectRefused(() => assertAgentExecution(lease.context, replacement), PLACEMENT_REFUSED);
        expect(agentInvocation(lease.context, COMMAND, ARGS)).toEqual(mountInvocation(namespace.pid));
    } finally { lease.release(); service.close(admission); }
});

test("borrowers have independent validity and only the last release disposes the namespace", async () => {
    const service = unprivilegedExecutionService();
    const admission = await service.admit();
    const namespace = tracked(registerAgentDomainEntry(62216, DOMAIN));
    const fixture = anchored(namespace.pid, namespace);
    const first = service.acquire(admission, fixture.placement);
    const second = service.borrow(first.context);
    const third = service.borrow(second.context);
    try {
        expect(second.context).toEqual({ mode: "unprivileged", cwd: VIEW });
        expect(third.context).toEqual({ mode: "unprivileged", cwd: VIEW });
        expect(second.context).not.toBe(first.context);
        expect(third.context).not.toBe(second.context);
        expect(Object.isFrozen(second.context)).toBe(true);
        first.release();
        first.release();
        expectRefused(() => agentInvocation(first.context, COMMAND, ARGS), CONTEXT_REFUSED);
        expectRefused(() => assertAgentExecution(first.context, { cwd: VIEW, isolation: fixture.placement.isolation }), CONTEXT_REFUSED);
        expectRefused(() => service.borrow(first.context), CONTEXT_REFUSED);
        expect(fixture.dispose).not.toHaveBeenCalled();
        expect(agentEntrant(namespace, VIEW, COMMAND, ARGS)).toEqual(domainInvocation(namespace.pid));
        expect(agentInvocation(second.context, COMMAND, ARGS)).toEqual(domainInvocation(namespace.pid));
        second.release();
        expectRefused(() => agentInvocation(second.context, COMMAND, ARGS), CONTEXT_REFUSED);
        expect(fixture.dispose).not.toHaveBeenCalled();
        expect(agentInvocation(third.context, COMMAND, ARGS)).toEqual(domainInvocation(namespace.pid));
        third.release();
        third.release();
        expect(fixture.dispose).toHaveBeenCalledTimes(1);
        expectRefused(() => agentInvocation(third.context, COMMAND, ARGS), CONTEXT_REFUSED);
        expect(() => agentEntrant(namespace, VIEW, COMMAND, ARGS)).toThrow("namespace anchor 62216 reference is not registered");
    } finally { first.release(); second.release(); third.release(); service.close(admission); }
});

test.each(["cwd", "pid", "namespace", "reconstructed namespace", "removed namespace"] as const)("a mutated descriptor's %s cannot redirect a context or pass request validation", async (kind) => {
    const service = unprivilegedExecutionService();
    const admission = await service.admit();
    const namespace = tracked(registerAgentDomainEntry(62225, DOMAIN));
    const fixture = anchored(namespace.pid, namespace);
    const lease = service.acquire(admission, fixture.placement);
    if (kind === "cwd") { fixture.anchor.cwd = "/other/view"; }
    if (kind === "pid") { fixture.anchor.pid = 62226; }
    if (kind === "namespace") { fixture.anchor.namespace = tracked(registerAgentDomainEntry(62226, DOMAIN)); }
    if (kind === "reconstructed namespace") { fixture.anchor.namespace = { ...namespace }; }
    if (kind === "removed namespace") { delete fixture.anchor.namespace; }
    try {
        expect(agentInvocation(lease.context, COMMAND, ARGS)).toEqual(domainInvocation(namespace.pid));
        expectRefused(() => assertAgentExecution(lease.context, { cwd: VIEW, isolation: fixture.placement.isolation }), PLACEMENT_REFUSED);
        const borrower = service.borrow(lease.context);
        try { expect(agentInvocation(borrower.context, COMMAND, ARGS)).toEqual(domainInvocation(namespace.pid)); }
        finally { borrower.release(); }
        expect(fixture.dispose).not.toHaveBeenCalled();
    } finally { lease.release(); service.close(admission); }
    expect(fixture.dispose).toHaveBeenCalledTimes(1);
});

test("captured target, cwd, plan, anchor and disposer survive mutation of descriptive placement inputs", async () => {
    const service = unprivilegedExecutionService();
    const admission = await service.admit();
    const namespace = tracked(registerAgentDomainEntry(62217, DOMAIN));
    const fixture = anchored(namespace.pid, namespace);
    const originalPlan = fixture.placement.isolation.plan;
    const originalAnchor = fixture.anchor;
    const lease = service.acquire(admission, fixture.placement);
    const otherEntry = { userNamespace: "/proc/62302/ns/user", home: "/home/other" };
    const otherNamespace = tracked(registerAgentDomainEntry(62218, otherEntry));
    const replacement = anchored(otherNamespace.pid, otherNamespace);
    fixture.anchor.pid = otherNamespace.pid;
    fixture.anchor.namespace = otherNamespace;
    fixture.anchor.cwd = "/other/view";
    fixture.anchor.plan = replacement.placement.isolation.plan;
    fixture.anchor.dispose = replacement.dispose;
    fixture.placement.localCwd = "/other/local";
    fixture.placement.isolation = replacement.placement.isolation;
    try {
        expect(lease.context).toEqual({ mode: "unprivileged", cwd: VIEW });
        expect(agentInvocation(lease.context, COMMAND, ARGS)).toEqual(domainInvocation(namespace.pid));
        expectRefused(() => assertAgentExecution(lease.context, { cwd: VIEW, isolation: { plan: originalPlan, anchor: originalAnchor } }), PLACEMENT_REFUSED);
        expectRefused(() => assertAgentExecution(lease.context, { cwd: VIEW, isolation: fixture.placement.isolation }), PLACEMENT_REFUSED);
        const borrower = service.borrow(lease.context);
        try {
            expect(agentInvocation(borrower.context, COMMAND, ARGS)).toEqual(domainInvocation(namespace.pid));
            lease.release();
            expect(fixture.dispose).not.toHaveBeenCalled();
            borrower.release();
            expect(fixture.dispose).toHaveBeenCalledTimes(1);
            expect(replacement.dispose).not.toHaveBeenCalled();
            expect(() => agentEntrant(namespace, VIEW, COMMAND, ARGS)).toThrow("namespace anchor 62217 reference is not registered");
            expect(agentEntrant(otherNamespace, VIEW, COMMAND, ARGS)).toEqual(domainInvocation(otherNamespace.pid, VIEW, otherEntry));
        } finally { borrower.release(); }
    } finally { lease.release(); service.close(admission); }
});

test.each(["wrong reference kind", "closed admission", "unclean cwd"] as const)("preparation scope retains cleanup when acquire fails on %s", async (kind) => {
    const service = unprivilegedExecutionService();
    const admission = await service.admit();
    const namespace = tracked(kind === "wrong reference kind" ? registerMountEntry(62219) : registerAgentDomainEntry(62219, DOMAIN));
    const fixture = anchored(namespace.pid, namespace);
    if (kind === "closed admission") { service.close(admission); }
    if (kind === "unclean cwd") { fixture.placement.localCwd = "relative/worktree"; }
    const scope = agentExecutionScope(service, admission);
    const replacedDispose = jest.fn();
    try {
        const message = kind === "wrong reference kind" ? "agent domain anchor 62219 is not registered"
            : kind === "closed admission" ? ADMISSION_REFUSED : CLEAN_CWD_REFUSED;
        expectRefused(() => scope.acquire(fixture.placement), message);
        expect(fixture.dispose).not.toHaveBeenCalled();
        fixture.anchor.dispose = replacedDispose;
        scope.dispose();
        scope.dispose();
        expect(fixture.dispose).toHaveBeenCalledTimes(1);
        expect(replacedDispose).not.toHaveBeenCalled();
        expectRefused(() => scope.acquire(fixture.placement), SCOPE_REFUSED);
    } finally { scope.dispose(); service.close(admission); }
});

test("a failed acquire consumes its scope without taking ownership of a second placement", async () => {
    const service = unprivilegedExecutionService();
    const admission = await service.admit();
    const firstNamespace = tracked(registerMountEntry(62220));
    const first = anchored(firstNamespace.pid, firstNamespace);
    const secondNamespace = tracked(registerAgentDomainEntry(62221, DOMAIN));
    const second = anchored(secondNamespace.pid, secondNamespace);
    const scope = agentExecutionScope(service, admission);
    try {
        expectRefused(() => scope.acquire(first.placement), "agent domain anchor 62220 is not registered");
        expectRefused(() => scope.acquire(second.placement), SCOPE_REFUSED);
        expect(first.dispose).not.toHaveBeenCalled();
        expect(second.dispose).not.toHaveBeenCalled();
        scope.dispose();
        expect(first.dispose).toHaveBeenCalledTimes(1);
        expect(second.dispose).not.toHaveBeenCalled();
        expect(agentEntrant(secondNamespace, VIEW, COMMAND, ARGS)).toEqual(domainInvocation(secondNamespace.pid));
    } finally { scope.dispose(); second.dispose(); service.close(admission); }
});

test("closing an unacquired scope refuses acquisition without claiming the proposed anchor", async () => {
    const service = unprivilegedExecutionService();
    const admission = await service.admit();
    const namespace = tracked(registerAgentDomainEntry(62222, DOMAIN));
    const fixture = anchored(namespace.pid, namespace);
    const scope = agentExecutionScope(service, admission);
    scope.dispose();
    scope.dispose();
    try {
        expectRefused(() => scope.acquire(fixture.placement), SCOPE_REFUSED);
        expect(fixture.dispose).not.toHaveBeenCalled();
        const lease = service.acquire(admission, fixture.placement);
        try { expect(agentInvocation(lease.context, COMMAND, ARGS)).toEqual(domainInvocation(namespace.pid)); }
        finally { lease.release(); }
        expect(fixture.dispose).toHaveBeenCalledTimes(1);
    } finally { scope.dispose(); service.close(admission); }
});

test("a successful scope acquires once and transfers namespace lifetime to independent borrowers", async () => {
    const service = unprivilegedExecutionService();
    const admission = await service.admit();
    const namespace = tracked(registerAgentDomainEntry(62223, DOMAIN));
    const fixture = anchored(namespace.pid, namespace);
    const otherNamespace = tracked(registerAgentDomainEntry(62224, DOMAIN));
    const other = anchored(otherNamespace.pid, otherNamespace);
    const scope = agentExecutionScope(service, admission);
    const context = scope.acquire(fixture.placement);
    const borrower = service.borrow(context);
    try {
        expect(context).toEqual({ mode: "unprivileged", cwd: VIEW });
        expect(agentInvocation(context, COMMAND, ARGS)).toEqual(domainInvocation(namespace.pid));
        expectRefused(() => scope.acquire(other.placement), SCOPE_REFUSED);
        expect(other.dispose).not.toHaveBeenCalled();
        scope.dispose();
        scope.dispose();
        expectRefused(() => agentInvocation(context, COMMAND, ARGS), CONTEXT_REFUSED);
        expectRefused(() => scope.acquire(other.placement), SCOPE_REFUSED);
        expect(fixture.dispose).not.toHaveBeenCalled();
        expect(agentInvocation(borrower.context, COMMAND, ARGS)).toEqual(domainInvocation(namespace.pid));
        borrower.release();
        expect(fixture.dispose).toHaveBeenCalledTimes(1);
        expect(other.dispose).not.toHaveBeenCalled();
        expect(() => agentEntrant(namespace, VIEW, COMMAND, ARGS)).toThrow("namespace anchor 62223 reference is not registered");
    } finally { scope.dispose(); borrower.release(); other.dispose(); service.close(admission); }
});
