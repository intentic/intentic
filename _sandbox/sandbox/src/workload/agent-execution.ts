import type { AgentDomainPolicy } from "@intentic/sandbox-contract";
import { isAbsolute, normalize, relative, sep } from "node:path";
import type { TurnPlacement } from "../conversations/worktrees/isolation.js";
import { requireAgentDomainRollout } from "./agent-domain-rollout.js";
import { agentEntrant, namespaceTargetOf, nsenterArgv, type NamespaceEntryReference, type NamespaceEntrant } from "./namespace-entry.js";

// Daemon-local handles, never request/wire shapes. Public fields describe the view; only the private registries below
// authorize its use. Worktree placement and workload scheduling are not execution authority.
export interface AgentExecutionAdmission { readonly mode: AgentDomainPolicy["agentDomain"] }
export interface AgentExecutionContext {
    readonly mode: AgentDomainPolicy["agentDomain"];
    readonly cwd: string;
}
export interface AgentExecutionLease {
    readonly context: AgentExecutionContext;
    readonly release: () => void;
}
export interface AgentExecutionPlacement {
    readonly localCwd: string;
    readonly isolation?: TurnPlacement;
}
export interface AgentExecutionService {
    readonly admit: () => Promise<AgentExecutionAdmission>;
    readonly close: (admission: AgentExecutionAdmission) => void;
    readonly acquire: (admission: AgentExecutionAdmission, placement: AgentExecutionPlacement) => AgentExecutionLease;
    readonly borrow: (context: AgentExecutionContext) => AgentExecutionLease;
}
export interface AgentInvocation extends NamespaceEntrant {
    // A namespaced cwd is selected by --wdns, never resolved against the daemon's checkout before entry.
    readonly cwd?: string;
}

export class AgentDomainRefusedError extends Error {
    readonly code = "agent-domain-refused";
    constructor(message: string, cause?: unknown) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = "AgentDomainRefusedError";
    }
}

interface ExecutionGroup {
    readonly mode: AgentDomainPolicy["agentDomain"];
    readonly cwd: string;
    readonly plan: TurnPlacement["plan"] | undefined;
    readonly anchor: TurnPlacement["anchor"];
    readonly target: number | NamespaceEntryReference | undefined;
    readonly dispose: (() => void) | undefined;
    borrowers: number;
}
interface ExecutionState {
    readonly owner: object;
    readonly group: ExecutionGroup;
    active: boolean;
}
const contexts = new WeakMap<AgentExecutionContext, ExecutionState>();
const refused = (message: string): never => { throw new AgentDomainRefusedError(message); };
const checked = (context: AgentExecutionContext): ExecutionState => {
    const state = contexts.get(context);
    if (state === undefined || !state.active) { return refused("Agent execution context is not registered or has been released."); }
    return state;
};
const cleanCwd = (cwd: string): string => {
    if (!isAbsolute(cwd) || normalize(cwd) !== cwd || /[\u0000-\u001f\u007f]/u.test(cwd)) {
        return refused("Agent execution requires an absolute, clean working directory.");
    }
    return cwd;
};
const withinView = (root: string, cwd: string): string => {
    const path = cleanCwd(cwd);
    const rel = relative(root, path);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        return refused("Agent execution cwd does not belong to the admitted view.");
    }
    return path;
};
const entered = (group: ExecutionGroup, cwd: string, command: string, args: readonly string[]): AgentInvocation => {
    try {
        if (group.mode === "unprivileged") {
            // Numeric compatibility and plain mount/fenced entries cannot stand in for a domain capability.
            if (group.target === undefined || typeof group.target === "number") {
                return refused("Unprivileged execution requires an issued domain namespace reference.");
            }
            return agentEntrant(group.target, cwd, command, args);
        }
        return group.target === undefined ? { command, args: [...args], cwd } : nsenterArgv(group.target, cwd, command, args);
    } catch (error) {
        if (error instanceof AgentDomainRefusedError) { throw error; }
        throw new AgentDomainRefusedError(error instanceof Error ? error.message : String(error), error);
    }
};

// Construct immediately before spawn. These checks establish registry generation, not pinned kernel namespace
// identity; a saved argv can outlive this check. Kernel handles and launch-door enforcement remain rollout prerequisites.
export const agentInvocation = (context: AgentExecutionContext, command: string, args: readonly string[], cwd?: string): AgentInvocation => {
    const { group } = checked(context);
    return entered(group, withinView(group.cwd, cwd ?? group.cwd), command, args);
};

// Helpers and session probes have no TurnSpec, but still need a live issued context. No process is launched by this
// check; a process-capable caller must also construct its actual invocation immediately before spawn.
export const assertAgentExecutionContext = (context: AgentExecutionContext, cwd?: string): void => {
    const { group } = checked(context);
    entered(group, withinView(group.cwd, cwd ?? group.cwd), "true", []);
};

// Temporary closure for process-capable services which cannot yet own/join a domain. Checking identity first keeps a
// forged descriptive `mode: root` from becoming authority. Refuse rather than using an in-process/shared root service.
export const requireRootAgentExecution = (context: AgentExecutionContext, operation: string, cwd?: string): void => {
    assertAgentExecutionContext(context, cwd);
    if (checked(context).group.mode !== "root") {
        return refused(`${operation} does not support unprivileged agent execution yet.`);
    }
};

// armPlan may replace words/model fields, but not choose a different execution view or namespace by replacing spec.
export const assertAgentExecution = (context: AgentExecutionContext, placement: { readonly cwd: string; readonly isolation?: TurnPlacement }): void => {
    const { group } = checked(context);
    const anchor = placement.isolation?.anchor;
    if (placement.cwd !== group.cwd || placement.isolation?.plan !== group.plan || anchor !== group.anchor ||
        (anchor !== undefined && (anchor.cwd !== group.cwd || namespaceTargetOf(anchor) !== group.target ||
            anchor.pid !== (typeof group.target === "number" ? group.target : group.target?.pid)))) {
        return refused("Agent request placement does not match its admitted execution context.");
    }
    entered(group, group.cwd, "true", []);
};

// The turn owns this scope before preparation starts. Acquisition failure still leaves its newly built placement
// owned here; success transfers that ownership to the lease. Closing also covers generator return during preparation.
export const agentExecutionScope = (service: AgentExecutionService, admission: AgentExecutionAdmission) => {
    let acquired = false;
    let closed = false;
    let release: (() => void) | undefined;
    return {
        // Which domain the admission chose, for the preparation that places the turn (stream-agent.ts isolationOf).
        mode: admission.mode,
        acquire: (placement: AgentExecutionPlacement): AgentExecutionContext => {
            if (closed || acquired) { return refused("Agent execution preparation scope is closed or already acquired."); }
            acquired = true;
            release = placement.isolation?.anchor?.dispose;
            const lease = service.acquire(admission, placement);
            release = lease.release;
            return lease.context;
        },
        dispose: (): void => {
            if (closed) { return; }
            closed = true;
            const drop = release;
            release = undefined;
            drop?.();
        },
    };
};

// Acquisition happens before calling the helper (and before its first await), so a detached helper already owns its
// view when the parent closes admission. Its lifetime is independent of the turn preparation scope.
export const withAdmittedAgentExecution = async <T>(
    service: AgentExecutionService,
    admission: AgentExecutionAdmission,
    placement: AgentExecutionPlacement,
    use: (context: AgentExecutionContext) => Promise<T>,
): Promise<T> => {
    const scope = agentExecutionScope(service, admission);
    try {
        return await use(scope.acquire(placement));
    } finally {
        scope.dispose();
    }
};

// Helpers outside a live turn must independently read protected policy and own admission and placement. A plain
// workspace placement cannot authorize unprivileged execution; acquisition refuses until a real domain is supplied.
export const withAgentExecution = async <T>(
    service: AgentExecutionService,
    placement: AgentExecutionPlacement,
    use: (context: AgentExecutionContext) => Promise<T>,
): Promise<T> => {
    const admission = await service.admit();
    try {
        return await withAdmittedAgentExecution(service, admission, placement, use);
    } finally {
        service.close(admission);
    }
};

const leaseFor = (owner: object, group: ExecutionGroup): AgentExecutionLease => {
    const context = Object.freeze({ mode: group.mode, cwd: group.cwd });
    const state: ExecutionState = { owner, group, active: true };
    contexts.set(context, state);
    group.borrowers += 1;
    return Object.freeze({
        context,
        release: () => {
            if (!state.active) { return; }
            // Invocation validity ends now, even while another borrower or detached descendant holds the namespace.
            state.active = false;
            group.borrowers -= 1;
            if (group.borrowers === 0) { group.dispose?.(); }
        },
    });
};

// The policy reader and rollout check are daemon composition dependencies, never caller/request options. The injectable
// check lets pure tests exercise closed-rollout coordination without enabling a live execution path.
export const createAgentExecutionService = (
    readPolicy: () => Promise<AgentDomainPolicy>,
    rollout: (policy: AgentDomainPolicy) => void = requireAgentDomainRollout,
): AgentExecutionService => {
    const owner = {};
    const admissions = new WeakMap<AgentExecutionAdmission, { active: boolean }>();
    return {
        admit: async () => {
            try {
                const policy = await readPolicy();
                rollout(policy);
                const admission = Object.freeze({ mode: policy.agentDomain });
                admissions.set(admission, { active: true });
                return admission;
            } catch (error) {
                throw new AgentDomainRefusedError(error instanceof Error ? error.message : String(error), error);
            }
        },
        close: (admission) => {
            const state = admissions.get(admission);
            if (state !== undefined) { state.active = false; }
        },
        acquire: (admission, placement) => {
            if (admissions.get(admission)?.active !== true) { return refused("Agent execution admission is not registered or has been closed."); }
            const anchor = placement.isolation?.anchor;
            const cwd = cleanCwd(anchor?.cwd ?? placement.localCwd);
            cleanCwd(placement.localCwd);
            if (anchor?.namespace !== undefined && anchor.pid !== anchor.namespace.pid) {
                return refused("Agent placement and namespace reference do not identify the same anchor.");
            }
            if (admission.mode === "unprivileged" && placement.isolation?.plan.fence !== undefined) {
                return refused("Unprivileged execution does not yet support fenced-domain composition.");
            }
            // Capture the target now; mutating the descriptive anchor later cannot select a different generation.
            const group: ExecutionGroup = {
                mode: admission.mode, cwd, plan: placement.isolation?.plan, anchor,
                target: anchor === undefined ? undefined : namespaceTargetOf(anchor),
                dispose: anchor?.dispose,
                borrowers: 0,
            };
            entered(group, cwd, "true", []);
            return leaseFor(owner, group);
        },
        borrow: (context) => {
            const state = checked(context);
            if (state.owner !== owner) { return refused("Agent execution context belongs to a different daemon coordinator."); }
            entered(state.group, state.group.cwd, "true", []);
            return leaseFor(owner, state.group);
        },
    };
};
