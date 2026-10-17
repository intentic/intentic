import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { type Persona, PersonaPowersSchema } from "@intentic/sandbox-contract/schemas/personas";
import { SandboxSettingsSchema } from "@intentic/sandbox-contract/schemas/settings";
import { createCredentialGrants } from "../../../secrets/credential-grants.js";
import { REACH_ALL } from "../../../secrets/credential-reach.js";
import { assertAgentExecution, createAgentExecutionService, type AgentExecutionContext } from "../../../workload/agent-execution.js";
import type { IsolationPlan, TurnPlacement } from "../../../conversations/worktrees/isolation.js";
import { conversationAfter } from "../../../conversations/registry/agents-store.testing.js";
import { armPlan, type TurnContext } from "../../providers/adapter.js";
import type { AgentRequest, ContainerCredential } from "../../providers/agent-request.js";
import { opt } from "../../../opt.js";
import { base, context as planContext, turn } from "../turn/turn-plan.testing.js";
import { decideTurn } from "./turn-decision.js";
import type { AdmittedTurnFacts } from "./turn-facts.js";

// Regression: a project persona's workspace.startIn caused every turn to be refused with "Agent request placement
// does not match its admitted execution context." because honoured.ts set spec.cwd to <root>/<startIn> while
// assertAgentExecution demanded exact cwd equality with the admitted view root. The fix accepts cwd inside the view.

const ROOT = "/nowhere/turn-plan";
const PROJECT = "my-project-16chr";

const projectPersona: Persona = {
    id: `project-${PROJECT}`,
    label: PROJECT,
    capabilities: [],
    powers: PersonaPowersSchema.parse({}),
    workspace: { startIn: PROJECT, folders: [PROJECT] },
    context: { repos: [PROJECT] },
};

const FACTS: AdmittedTurnFacts = {
    root: ROOT,
    entry: undefined,
    settings: SandboxSettingsSchema.parse({}),
    repoChecks: [],
    declared: undefined,
    installed: [],
    setup: [],
    personas: [projectPersona],
    areas: [],
    grant: undefined,
    skillCatalogNote: undefined,
    contextNote: undefined,
    turnContext: undefined,
    gates: [],
    releases: createCredentialGrants(),
    reach: REACH_ALL,
    iqTeaching: undefined,
    fieldNotes: undefined,
    personaPrompt: undefined,
    memoryNote: undefined,
    mapNote: undefined,
    landingChecksNote: undefined,
    sessionStore: `${ROOT}/sessions`,
};

const issuer = createAgentExecutionService(async () => ({ agentDomain: "root" }));

const placed = async (isolated: boolean): Promise<{ context: TurnContext; execution: AgentExecutionContext }> => {
    const admission = await issuer.admit();
    const localCwd = isolated ? "/nowhere/worktrees/conv-1" : ROOT;
    const plan: IsolationPlan = { root: ROOT, worktree: localCwd, mirrors: [], overlays: `${ROOT}/overlays`, fence: undefined };
    const isolation: TurnPlacement | undefined = isolated ? { plan } : undefined;
    const execution = issuer.acquire(admission, { localCwd, ...opt("isolation", isolation) }).context;
    const context: TurnContext = {
        ...planContext,
        base: { ...base, execution, spec: { prompt: "do the thing", cwd: execution.cwd, ...opt("isolation", isolation) } },
        localCwd,
        effectiveCwd: execution.cwd,
    };
    return { context, execution };
};

const runArm = async (input: ReturnType<typeof turn>, facts: AdmittedTurnFacts, isolated = false): Promise<{ cwd: string; group: string; ran: boolean }> => {
    const { context, execution } = await placed(isolated);
    const decision = decideTurn(facts, input, context);
    if (!decision.ok) { throw new Error(`decision refused: ${decision.message}`); }
    let ran = false;
    const done: AgentEvent = { kind: "done" };
    const request: AgentRequest<ContainerCredential> = { ...decision.context.base, credential: { kind: "container" } };
    const plan = armPlan(async function* () { ran = true; yield done; }, request);
    for await (const _ of plan.run(plan.request.spec)) { /* drain */ }
    return { cwd: plan.request.spec.cwd, group: execution.cwd, ran };
};

test("a chat acting as Anyone runs", async () => {
    expect(await runArm(turn({ agent: "codex" }), FACTS)).toEqual({ cwd: ROOT, group: ROOT, ran: true });
});

// This is the core regression: the project persona's startIn sets spec.cwd to <root>/<project>, which must pass.
test("a chat acting as a project persona runs (startIn subfolder accepted)", async () => {
    const result = await runArm(turn({ agent: "codex", actsAs: projectPersona.id }), FACTS);
    expect(result.ran).toBe(true);
    expect(result.cwd).toBe(`${ROOT}/${PROJECT}`);
});

test("claude runtime with project persona runs", async () => {
    const result = await runArm(turn({ agent: "claude", actsAs: projectPersona.id }), FACTS);
    expect(result.ran).toBe(true);
    expect(result.cwd).toBe(`${ROOT}/${PROJECT}`);
});

test("an isolated worktree turn with project persona runs", async () => {
    const result = await runArm(turn({ agent: "codex", actsAs: projectPersona.id }), FACTS, true);
    expect(result.ran).toBe(true);
});

test("persona deleted: identity.startIn still runs (subfolder accepted)", async () => {
    const entry = conversationAfter(3, { identity: { startIn: PROJECT } });
    const result = await runArm(turn({ agent: "codex", actsAs: projectPersona.id, conversationId: entry.id }), { ...FACTS, personas: [], entry });
    expect(result.ran).toBe(true);
    expect(result.cwd).toBe(`${ROOT}/${PROJECT}`);
});

test("persona switched back to Anyone on a latched identity.startIn still runs", async () => {
    const entry = conversationAfter(3, { identity: { startIn: PROJECT } });
    const result = await runArm(turn({ agent: "codex", conversationId: entry.id }), { ...FACTS, entry });
    expect(result.ran).toBe(true);
    expect(result.cwd).toBe(`${ROOT}/${PROJECT}`);
});

test("Send again: repeated sends succeed", async () => {
    for (let press = 0; press < 3; press += 1) {
        const result = await runArm(turn({ agent: "codex", actsAs: projectPersona.id }), FACTS);
        expect(result.ran).toBe(true);
    }
});

// Invariant: every decideTurn result's spec passes assertAgentExecution against the context it was built from.
test("every turn decision's request passes assertAgentExecution against its own execution context", async () => {
    for (const agent of ["codex", "claude"] as const) {
        for (const actsAs of [undefined, projectPersona.id] as const) {
            for (const isolated of [false, true]) {
                const { context } = await placed(isolated);
                const decision = decideTurn(FACTS, turn({ agent, actsAs }), context);
                if (!decision.ok) { continue; }
                // This is the invariant: spec must pass the assertion against its own execution.
                expect(() => assertAgentExecution(decision.context.base.execution, decision.context.base.spec)).not.toThrow();
            }
        }
    }
});
