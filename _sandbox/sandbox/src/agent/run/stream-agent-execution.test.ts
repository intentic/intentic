import { type AgentDomainPolicy, type AgentEvent, type SandboxSettings, SandboxSettingsSchema, type TurnNote } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../composition.js";
import * as turnEnvironment from "../../capabilities/turn-env.js";
import * as repoSync from "../../workspace/layout/sync-repos.js";
import * as turnPlanning from "./turn/turn-plan.js";
import { AGENT_DOMAIN_NOT_READY } from "../../workload/domain/agent-domain-rollout.js";
import {
    AgentDomainRefusedError,
    agentInvocation,
    createAgentExecutionService,
    type AgentExecutionAdmission,
    type AgentExecutionContext,
    type AgentExecutionService,
} from "../../workload/agent-execution.js";
import { armPlan, type TurnContext } from "../providers/adapter.js";
import type { AgentRequest } from "../providers/agent-request.js";
import { briefingOf } from "../prompt/turn-briefing.js";
import type { TurnInput } from "../../seams/turn-starter.js";

// Root-mode, conversationless main-tree turns only. The real stream owns real issued admissions and leases; its
// opaque environment, repo-sync and planning collaborators supply data without discovering files or launching a
// runtime. Successful planning normally reads workspace memory, and even an empty environment reads extension
// settings, so a route-services fake alone would not make these tests pure. No namespace/process APIs are mocked.
const originalEnvironment = { ...turnEnvironment };
const originalRepoSync = { ...repoSync };
const originalPlanning = { ...turnPlanning };

interface PureTurn {
    readonly operations: string[];
    readonly plan: (context: TurnContext) => Promise<turnPlanning.TurnPlan>;
}
const turns = new Map<Services, PureTurn>();
const pureTurn = (services: Services): PureTurn => {
    const turn = turns.get(services);
    if (turn === undefined) {
        throw new Error("the pure stream fixture did not register its services");
    }
    return turn;
};

jest.mock("../../capabilities/turn-env.js", () => ({
    ...originalEnvironment,
    turnCliEnv: async (services: Services) => {
        pureTurn(services).operations.push("environment");
        return {};
    },
}));
jest.mock("../../workspace/layout/sync-repos.js", () => ({
    ...originalRepoSync,
    syncWorkspaceRepos: async (services: Services) => {
        pureTurn(services).operations.push("repo-sync");
        return [];
    },
}));
jest.mock("./turn/turn-plan.js", () => ({
    ...originalPlanning,
    planTurn: async (services: Services, _input: TurnInput, context: TurnContext) => {
        const turn = pureTurn(services);
        turn.operations.push("plan");
        return turn.plan(context);
    },
}));

// Bun mocks are not hoisted. Load once after the collaborators are installed, outside any test's timeout clock.
const { streamAgent } = await import("./stream-agent.js");

afterEach(() => turns.clear());
afterAll(() => {
    // suites also uses --isolate, but return these exports for a caller running several files in one registry.
    jest.mock("../../capabilities/turn-env.js", () => originalEnvironment);
    jest.mock("../../workspace/layout/sync-repos.js", () => originalRepoSync);
    jest.mock("./turn/turn-plan.js", () => originalPlanning);
});

const ROOT = "/pure-stream-workspace";
const RELEASED = "Agent execution context is not registered or has been released.";
const CLOSED = "Agent execution admission is not registered or has been closed.";
const NOTE: TurnNote = { title: "Synthetic preamble", text: "A data-only opening note." };
const input: TurnInput = { prompt: "answer the synthetic turn" };

interface FixtureOptions {
    readonly policy?: () => Promise<AgentDomainPolicy>;
    // The rollout check the issuer applies; the default keeps unprivileged mode closed, as the daemon does.
    readonly rollout?: (policy: AgentDomainPolicy) => void;
    // Whether this sandbox can build namespaces, as turnIsolation answers it.
    readonly namespaces?: boolean;
    readonly settings?: () => Promise<SandboxSettings>;
    readonly plan?: (context: TurnContext) => Promise<turnPlanning.TurnPlan>;
    readonly runtime?: (request: AgentRequest) => AsyncGenerator<AgentEvent>;
    readonly probe?: (sessionId: string, execution: AgentExecutionContext) => Promise<boolean>;
    readonly append?: Services["activity"]["append"];
    readonly notes?: readonly TurnNote[];
    readonly snapshot?: string;
}

const fixture = (options: FixtureOptions = {}) => {
    const operations: string[] = [];
    const lifecycle: string[] = [];
    const admissions: AgentExecutionAdmission[] = [];
    const contexts: AgentExecutionContext[] = [];
    const planned: TurnContext[] = [];
    const ran: AgentRequest[] = [];
    const warnings: unknown[][] = [];
    const activity: Parameters<Services["activity"]["append"]>[0][] = [];
    const usage: Parameters<Services["usage"]["record"]>[0][] = [];
    const published: { readonly name: string; readonly payload: unknown }[] = [];
    const policy = unstubbed<Services["agentDomainPolicy"]>("agentDomainPolicy", {
        get: async () => {
            operations.push("policy");
            return options.policy === undefined ? { agentDomain: "root" } : options.policy();
        },
    });
    const issuer = createAgentExecutionService(policy.get, options.rollout);
    const executionService: AgentExecutionService = {
        admit: async () => {
            lifecycle.push("admit");
            const admission = await issuer.admit();
            admissions.push(admission);
            return admission;
        },
        acquire: (admission, placement) => {
            lifecycle.push("acquire");
            const lease = issuer.acquire(admission, placement);
            contexts.push(lease.context);
            return {
                context: lease.context,
                release: () => {
                    lifecycle.push("release");
                    lease.release();
                },
            };
        },
        close: (admission) => {
            lifecycle.push("close");
            expect(admissions).toEqual([admission]);
            issuer.close(admission);
        },
        borrow: issuer.borrow,
    };
    const adapter = unstubbed<ReturnType<Services["adapters"]["for"]>>("adapter", {
        holdsSession: async (_services, sessionId, execution) => {
            operations.push("session-probe");
            return options.probe === undefined ? true : options.probe(sessionId, execution);
        },
    });
    const services = unstubbed<Services>("services", {
        agentDomainPolicy: policy,
        agentExecution: executionService,
        // planFor stays unstubbed: a domain is never built here, so reaching it is a failure that names itself.
        turnIsolation: unstubbed<Services["turnIsolation"]>("turnIsolation", {
            available: async () => {
                operations.push("namespace-probe");
                return options.namespaces ?? true;
            },
        }),
        workspace: unstubbed<Services["workspace"]>("workspace", { root: ROOT }),
        cards: unstubbed<Services["cards"]>("cards", {}),
        adapters: unstubbed<Services["adapters"]>("adapters", { for: () => adapter }),
        perf: unstubbed<Services["perf"]>("perf", { track: async (_op, _fields, run) => run() }),
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", {
            get: async () => {
                operations.push("settings");
                return options.settings === undefined ? SandboxSettingsSchema.parse({}) : options.settings();
            },
        }),
        history: unstubbed<Services["history"]>("history", {
            snapshot: async () => {
                operations.push("checkpoint");
                return options.snapshot;
            },
            list: async () => [],
        }),
        logger: unstubbed<Services["logger"]>("logger", {
            warn: (...args: unknown[]) => void warnings.push(args),
        }),
        activity: unstubbed<Services["activity"]>("activity", {
            append: options.append ?? (async (event) => void activity.push(event)),
        }),
        providerRefusals: unstubbed<Services["providerRefusals"]>("providerRefusals", { clear: async () => {} }),
        usage: unstubbed<Services["usage"]>("usage", { record: async (turn) => void usage.push(turn) }),
        events: unstubbed<Services["events"]>("events", {
            publish: (name, payload) => void published.push({ name, payload }),
        }),
    });
    turns.set(services, {
        operations,
        plan: async (context) => {
            planned.push(context);
            if (options.plan !== undefined) {
                return options.plan(context);
            }
            const request: AgentRequest = {
                ...context.base,
                credential: { kind: "container" },
                spec: { ...context.base.spec, ...(options.notes === undefined ? {} : { notes: options.notes }) },
            };
            return {
                ...armPlan((runtimeRequest) => {
                    operations.push("runtime");
                    ran.push(runtimeRequest);
                    return options.runtime === undefined ? answered() : options.runtime(runtimeRequest);
                }, request),
                briefing: briefingOf(undefined),
                experiments: {},
            };
        },
    });
    return {
        services, issuer, operations, lifecycle, admissions, contexts, planned, ran, warnings, activity, usage, published,
        context: (): AgentExecutionContext => {
            const context = contexts[0];
            if (context === undefined) { throw new Error("this turn never acquired its execution context"); }
            return context;
        },
        admission: (): AgentExecutionAdmission => {
            const admission = admissions[0];
            if (admission === undefined) { throw new Error("this turn was never admitted"); }
            return admission;
        },
    };
};

async function* answered(): AsyncGenerator<AgentEvent> {
    yield { kind: "delta", text: "Synthetic answer." };
    yield { kind: "done" };
}

const collect = async (frames: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> => {
    const events: AgentEvent[] = [];
    for await (const frame of frames) { events.push(frame); }
    return events;
};

const expectLive = (turn: ReturnType<typeof fixture>): void => {
    expect(agentInvocation(turn.context(), "synthetic-command", ["argument"])).toEqual({
        command: "synthetic-command", args: ["argument"], cwd: ROOT,
    });
    expect(turn.lifecycle).toEqual(["admit", "acquire"]);
};

const expectReleased = (turn: ReturnType<typeof fixture>): void => {
    expect(turn.contexts).toHaveLength(1);
    expect(turn.lifecycle).toEqual(["admit", "acquire", "release", "close"]);
    expect(() => agentInvocation(turn.context(), "synthetic-command", [])).toThrow(RELEASED);
    expect(() => turn.issuer.acquire(turn.admission(), { localCwd: ROOT })).toThrow(CLOSED);
};

test("the retained protected rollout gate refuses at admission, before any preparation", async () => {
    const turn = fixture({ policy: async () => ({ agentDomain: "unprivileged" }) });
    expect(await collect(streamAgent(turn.services, input, undefined))).toEqual([
        { kind: "error", code: "agent-domain-refused", message: AGENT_DOMAIN_NOT_READY },
        { kind: "done" },
    ]);
    expect(turn.operations).toEqual(["policy"]);
    expect(turn.lifecycle).toEqual(["admit"]);
    expect(turn.admissions).toEqual([]);
    expect(turn.contexts).toEqual([]);
});

test("an unreadable protected policy refuses without trusting root mode or entering preparation", async () => {
    const turn = fixture({ policy: async () => { throw new Error("synthetic protected policy read failed"); } });
    expect(await collect(streamAgent(turn.services, input, undefined))).toEqual([
        { kind: "error", code: "agent-domain-refused", message: "synthetic protected policy read failed" },
        { kind: "done" },
    ]);
    expect(turn.operations).toEqual(["policy"]);
    expect(turn.lifecycle).toEqual(["admit"]);
    expect(turn.admissions).toEqual([]);
    expect(turn.contexts).toEqual([]);
});

test("a preflight refusal before acquisition still closes the real admission", async () => {
    const turn = fixture();
    expect(await collect(streamAgent(turn.services, { ...input, attachments: ["../outside"] }, undefined))).toEqual([
        { kind: "error", message: "invalid attachment path: ../outside" },
        { kind: "done" },
    ]);
    expect(turn.operations).toEqual(["policy", "environment"]);
    expect(turn.lifecycle).toEqual(["admit", "close"]);
    expect(turn.contexts).toEqual([]);
    expect(() => turn.issuer.acquire(turn.admission(), { localCwd: ROOT })).toThrow(CLOSED);
});

test("acquisition precedes late preflight, and a settings failure releases the lease and closes admission", async () => {
    const failure = new Error("synthetic settings failed after acquisition");
    const turn = fixture({ settings: async () => {
        expectLive(turn);
        throw failure;
    } });
    await expect(collect(streamAgent(turn.services, input, undefined))).rejects.toBe(failure);
    expect(turn.operations).toEqual(["policy", "environment", "repo-sync", "settings"]);
    expect(turn.planned).toEqual([]);
    expect(turn.ran).toEqual([]);
    expectReleased(turn);
});

test.each(["consume", "return"] as const)("a planner refusal releases its acquired context when callers %s", async (ending) => {
    const turn = fixture({ plan: async (context) => {
        expect(context.base.execution).toBe(turn.context());
        expectLive(turn);
        return { ok: false, message: "synthetic planner refusal" };
    } });
    const stream = streamAgent(turn.services, input, undefined);
    expect(await stream.next()).toEqual({ done: false, value: { kind: "error", message: "synthetic planner refusal" } });
    if (ending === "consume") {
        expect(await collect(stream)).toEqual([{ kind: "done" }]);
    } else {
        expect(await stream.return(undefined)).toEqual({ done: true, value: undefined });
    }
    expect(turn.planned).toHaveLength(1);
    expect(turn.ran).toEqual([]);
    expect(turn.operations).not.toContain("checkpoint");
    expectReleased(turn);
});

test("a thrown planner failure releases the preflight-owned context", async () => {
    const failure = new Error("synthetic planner threw");
    const turn = fixture({ plan: async () => { throw failure; } });
    await expect(collect(streamAgent(turn.services, input, undefined))).rejects.toBe(failure);
    expect(turn.planned).toHaveLength(1);
    expect(turn.ran).toEqual([]);
    expectReleased(turn);
});

test("generator return during the preamble releases ownership before checkpoint or runtime setup", async () => {
    const turn = fixture({ notes: [NOTE], snapshot: "synthetic-checkpoint" });
    const stream = streamAgent(turn.services, input, undefined);
    expect(await stream.next()).toEqual({ done: false, value: { kind: "preamble", notes: [NOTE] } });
    expect(turn.planned[0]?.base.execution).toBe(turn.context());
    expectLive(turn);
    expect(turn.operations).not.toContain("checkpoint");
    expect(turn.ran).toEqual([]);
    expect(await stream.return(undefined)).toEqual({ done: true, value: undefined });
    expect(await stream.return(undefined)).toEqual({ done: true, value: undefined });
    expect(turn.ran).toEqual([]);
    expectReleased(turn);
});

test("generator return at the checkpoint releases ownership before runtime setup", async () => {
    const turn = fixture({ snapshot: "synthetic-checkpoint" });
    const stream = streamAgent(turn.services, input, undefined);
    expect(await stream.next()).toEqual({ done: false, value: { kind: "checkpoint", id: "synthetic-checkpoint" } });
    expectLive(turn);
    expect(turn.ran).toEqual([]);
    expect(await stream.return(undefined)).toEqual({ done: true, value: undefined });
    expect(turn.ran).toEqual([]);
    expectReleased(turn);
});

test("a runtime setup exception before the runtime's own try/finally still releases outer ownership", async () => {
    const failure = new Error("synthetic activity setup failed");
    const turn = fixture({ append: () => {
        expectLive(turn);
        throw failure;
    } });
    await expect(collect(streamAgent(turn.services, input, undefined))).rejects.toBe(failure);
    expect(turn.planned).toHaveLength(1);
    expect(turn.operations).toContain("checkpoint");
    expect(turn.ran).toEqual([]);
    expect(turn.usage).toEqual([]);
    expectReleased(turn);
});

test("a synchronous runtime factory failure also releases execution and closes admission", async () => {
    const failure = new Error("synthetic runtime factory failed");
    const turn = fixture({ runtime: () => { throw failure; } });
    await expect(collect(streamAgent(turn.services, input, undefined))).rejects.toBe(failure);
    expect(turn.ran).toHaveLength(1);
    expect(turn.activity.map((event) => event.type)).toEqual(["turn.started", "turn.completed"]);
    expectReleased(turn);
});

test.each(["complete", "return"] as const)("the runtime has a real live lease until callers %s, then lease and admission close", async (ending) => {
    const runtimeFinalizers: AgentExecutionContext[] = [];
    const turn = fixture({ async *runtime (request) {
        expect(request.execution).toBe(turn.context());
        expect(request.spec.cwd).toBe(ROOT);
        expectLive(turn);
        try {
            yield { kind: "delta", text: "Synthetic answer." };
            yield { kind: "done" };
        } finally {
            expectLive(turn);
            runtimeFinalizers.push(request.execution);
        }
    } });
    const stream = streamAgent(turn.services, input, undefined);
    expect(await stream.next()).toEqual({ done: false, value: { kind: "delta", text: "Synthetic answer." } });
    expectLive(turn);
    if (ending === "complete") {
        expect(await stream.next()).toEqual({ done: false, value: { kind: "done" } });
        expectLive(turn);
        expect(await stream.next()).toEqual({ done: true, value: undefined });
    } else {
        expect(await stream.return(undefined)).toEqual({ done: true, value: undefined });
    }
    expect(runtimeFinalizers).toEqual([turn.context()]);
    expect(turn.ran).toHaveLength(1);
    expect(turn.activity.map((event) => event.type)).toEqual(["turn.started", "turn.completed"]);
    expect(turn.usage).toHaveLength(1);
    expect(turn.published).toEqual([{ name: "tree.changed", payload: { label: input.prompt } }]);
    expectReleased(turn);
});

test("a coded session-probe refusal is not swallowed as permission to resume", async () => {
    const turn = fixture({ probe: async (sessionId, execution) => {
        expect(sessionId).toBe("synthetic-session");
        expect(execution).toBe(turn.context());
        expect(execution.cwd).toBe(ROOT);
        expectLive(turn);
        throw new AgentDomainRefusedError("synthetic session execution refused");
    } });
    expect(await collect(streamAgent(turn.services, { ...input, sessionId: "synthetic-session", unattended: true }, undefined))).toEqual([
        { kind: "error", code: "agent-domain-refused", message: "synthetic session execution refused", unattended: true },
        { kind: "done" },
    ]);
    expect(turn.operations).toEqual(["policy", "environment", "repo-sync", "session-probe"]);
    expect(turn.planned).toEqual([]);
    expect(turn.ran).toEqual([]);
    expect(turn.warnings).toEqual([]);
    expectReleased(turn);
});

test("an ordinary session-store probe failure still trusts the requested session, unlike a coded refusal", async () => {
    const failure = new Error("synthetic session store unavailable");
    const turn = fixture({
        probe: async () => { throw failure; },
        plan: async (context) => {
            expect(context.base.spec.sessionId).toBe("synthetic-session");
            expect(context.base.execution).toBe(turn.context());
            return { ok: false, message: "synthetic planner refusal" };
        },
    });
    expect(await collect(streamAgent(turn.services, { ...input, sessionId: "synthetic-session" }, undefined))).toEqual([
        { kind: "error", message: "synthetic planner refusal" },
        { kind: "done" },
    ]);
    expect(turn.warnings).toEqual([[{ err: failure, sessionId: "synthetic-session" }, "session probe failed, resuming as asked"]]);
    expect(turn.planned).toHaveLength(1);
    expect(turn.ran).toEqual([]);
    expectReleased(turn);
});

// Unprivileged mode refuses what it cannot place in a domain before building anything, and never falls back to root.
// The rollout is opened here only so the stream reaches placement; the daemon keeps it closed (agent-domain-rollout.ts).
const unprivileged = { policy: async () => ({ agentDomain: "unprivileged" as const }), rollout: () => {} };

test("unprivileged mode refuses a runtime the domain cannot hold yet, before probing or placing anything", async () => {
    const turn = fixture(unprivileged);
    expect(await collect(streamAgent(turn.services, { ...input, agent: "codex" }, undefined))).toEqual([
        { kind: "error", message: "Only Claude Code runs inside the unprivileged agent domain so far. Switch this conversation to a Claude model, or set the agent domain back to root." },
        { kind: "done" },
    ]);
    expect(turn.operations).toEqual(["policy", "environment"]);
    expect(turn.lifecycle).toEqual(["admit", "close"]);
    expect(turn.contexts).toEqual([]);
});

test("unprivileged mode refuses a sandbox that cannot build namespaces rather than running the turn as root", async () => {
    const turn = fixture({ ...unprivileged, namespaces: false });
    expect(await collect(streamAgent(turn.services, input, undefined))).toEqual([
        { kind: "error", message: "This sandbox cannot build namespaces (it has no CAP_SYS_ADMIN), so the unprivileged agent domain cannot run here. Set the agent domain back to root, or recreate the sandbox with it." },
        { kind: "done" },
    ]);
    expect(turn.operations).toEqual(["policy", "environment", "namespace-probe"]);
    expect(turn.lifecycle).toEqual(["admit", "close"]);
    expect(turn.planned).toEqual([]);
    expect(turn.ran).toEqual([]);
});
