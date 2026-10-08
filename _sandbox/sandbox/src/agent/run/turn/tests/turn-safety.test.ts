import { HISTORY_ROOT, WORKSPACE_ROOT } from "@intentic/constants";
import { type ModelPin, SandboxSettingsSchema } from "@intentic/sandbox-contract";
import { mergeHeavyRules } from "@intentic/constants/heavy-rules";
import { unstubbed } from "@intentic/testing";
import type { Logger } from "pino";
import { parkedCards } from "../../../../conversations/actor/parked-cards.js";
import type { TurnPlacement } from "../../../../conversations/worktrees/isolation.js";
import { memoryConversationGrants } from "../../../../personas/conversation-grants.js";
import { memoryFleet } from "../../../../testing.js";
import type { TurnBase } from "../../../providers/agent-request.js";
import { type TurnSafetyDeps, withTurnSafety } from "../turn-safety.js";
import { assertAgentExecutionContext, type AgentExecutionContext } from "../../../../workload/agent-execution.js";
import { rootExecutionService } from "../../../../workload/agent-execution.testing.js";

// One place sets what every runtime's command gate is built with, so a Codex or Cursor turn is judged by the owner's
// policy, setting and grants exactly as a Claude Code turn is: these pin that the planner puts them on the base every
// runtime's plan starts from.

const cards = parkedCards(memoryFleet().conversations);

const executionService = rootExecutionService();
const admission = await executionService.admit();
const releases: (() => void)[] = [];
afterEach(() => { for (const release of releases.splice(0)) { release(); } });
afterAll(() => executionService.close(admission));

const baseOf = (over: { readonly isolation?: TurnPlacement; readonly canInstall?: boolean } = {}): TurnBase => {
    const lease = executionService.acquire(admission, { localCwd: WORKSPACE_ROOT, ...(over.isolation === undefined ? {} : { isolation: over.isolation }) });
    releases.push(lease.release);
    return {
        execution: lease.context,
        spec: { prompt: "p", cwd: WORKSPACE_ROOT, ...(over.isolation === undefined ? {} : { isolation: over.isolation }) },
        policy: { dependencyInstallAllowed: over.canInstall ?? true },
        tools: {},
        hooks: { cards },
        signal: new AbortController().signal,
    };
};

const harness = () => {
    const judged: { policy: string; program: string; pins: readonly ModelPin[] }[] = [];
    const executions: AgentExecutionContext[] = [];
    const conversationGrants = memoryConversationGrants();
    const deps: TurnSafetyDeps = {
        conversationGrants,
        // The shipped table, as a sandbox with no overrides reads it.
        heavyCommands: { read: async () => mergeHeavyRules() },
        judgeCommand: async (execution, request) => {
            assertAgentExecutionContext(execution);
            executions.push(execution);
            judged.push({ policy: request.policy, program: request.program, pins: request.pins });
            return { decision: "allow", sentence: "Fine." };
        },
        logger: unstubbed<Logger>("logger", { warn: () => undefined }),
        runtimeInstalls: unstubbed("runtimeInstalls", { record: async () => undefined }),
        safetyLog: unstubbed("safetyLog", { record: async () => undefined, answered: async () => undefined }),
        safetyPolicy: unstubbed("safetyPolicy", { text: async () => "# the owner's policy", append: async () => undefined }),
        workspace: unstubbed<TurnSafetyDeps["workspace"]>("workspace", { root: WORKSPACE_ROOT }),
    };
    return { deps, judged, executions, conversationGrants };
};

test("every runtime's base carries the owner's policy, judge mode, outside wake and install rule", async () => {
    const { deps, judged, executions } = harness();
    const settings = SandboxSettingsSchema.parse({ commandJudge: "watch", projectInstalls: "ask" });
    const base = await withTurnSafety(deps, { conversationId: "c1", outsideWake: "discord" }, baseOf(), settings);

    expect(base.policy).toEqual({ dependencyInstallAllowed: true, safetyPolicy: "# the owner's policy", judging: "watch", outsideWake: "discord" });
    expect(base.hooks.projectInstalls).toMatchObject({ placement: { kind: "shared" }, root: "/work", mode: "ask", canInstall: true });
    await base.hooks.judge?.("rm -rf /", { consequences: [], unattended: false, language: "bash" }, new AbortController().signal);
    expect(judged).toEqual([{ policy: "# the owner's policy", program: "rm -rf /", pins: [] }]);
    expect(executions).toEqual([base.execution]);
    expect(executions[0]).toBe(base.execution);
    expect(await base.tools.heavyCommands?.()).toMatchObject({ queue: true });
});

test("an isolated turn's install rule says it writes to its own copy, and a persona without the power is carried as such", async () => {
    const { deps } = harness();
    const isolation: TurnPlacement = {
        plan: {
            worktree: `${HISTORY_ROOT}/worktrees/c1`,
            root: WORKSPACE_ROOT,
            mirrors: [],
            overlays: `${HISTORY_ROOT}/overlays/c1`,
            fence: undefined,
        },
        anchor: {
            pid: 1,
            cwd: WORKSPACE_ROOT,
            plan: {
                worktree: `${HISTORY_ROOT}/worktrees/c1`,
                root: WORKSPACE_ROOT,
                mirrors: [],
                overlays: `${HISTORY_ROOT}/overlays/c1`,
                fence: undefined,
            },
            dispose: () => undefined,
        },
    };
    const base = await withTurnSafety(deps, { conversationId: "c1" }, baseOf({ isolation, canInstall: false }), SandboxSettingsSchema.parse({}));
    expect(base.hooks.projectInstalls?.placement.kind).toBe("private");
    expect(base.hooks.projectInstalls?.canInstall).toBe(false);
    expect(base.hooks.projectInstalls?.mode).toBe("automatic");
});

test("the install rule's grant is the conversation's kept one, and a turn with no conversation holds none", async () => {
    const { deps, conversationGrants } = harness();
    const base = await withTurnSafety(deps, { conversationId: "c1" }, baseOf(), SandboxSettingsSchema.parse({}));
    expect(await base.hooks.projectInstalls?.grants?.has()).toBe(false);
    await base.hooks.projectInstalls?.grants?.add();
    expect(await conversationGrants.installsAllowed("c1")).toBe(true);
    const unowned = await withTurnSafety(deps, {}, baseOf(), SandboxSettingsSchema.parse({}));
    expect(unowned.hooks.projectInstalls?.grants).toBeUndefined();
});
