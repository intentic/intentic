import { join } from "node:path";
import { HISTORY_ROOT, WORKSPACE_ROOT } from "@intentic/constants";
import { unstubbed } from "@intentic/testing";
import { pino } from "pino";
import type { Services } from "../../../composition.js";
import type { PersistedAgent } from "../../../conversations/registry/agents-store.js";
import { declarationOf, rulesOf } from "../../../rules/repo-checks.js";
import { noIsolation } from "../../../testing.js";
import type { TurnContext } from "../../providers/adapter.js";
import { context } from "../turn/turn-plan.testing.js";
import { harnessHooks, type HarnessHooksDeps } from "./harness-hooks.js";

// Which turns the repositories' `turn` checks are bound to: an isolated conversation's, and only where a repository
// declares one. Running them and reading the change are pinned where they live (run/turn-checks.test.ts, the land's
// own suites); this is the gate in front of both.

const TURN_CHECKS = rulesOf(declarationOf("intentic", [{ when: "turn", run: "node _tools/scripts/verify/verify-turn.mjs" }]));

const depsHolding = (entry: PersistedAgent | undefined): HarnessHooksDeps => ({
    workspace: unstubbed<Services["workspace"]>("workspace", { root: WORKSPACE_ROOT }),
    logger: pino({ level: "silent" }),
    ruleFirings: unstubbed<Services["ruleFirings"]>("ruleFirings", {}),
    agents: unstubbed<Services["agents"]>("agents", { entry: () => entry }),
    agentWorktrees: unstubbed<Services["agentWorktrees"]>("agentWorktrees", {}),
    perf: unstubbed<Services["perf"]>("perf", {}),
});

// The same turn, in a conversation's own worktree, as the route hands it over.
const isolated = async (): Promise<TurnContext> => {
    const worktree = join(HISTORY_ROOT, "worktrees", "c1");
    const plan = await noIsolation(WORKSPACE_ROOT).planFor(worktree, false);
    return { ...context, localCwd: worktree, base: { ...context.base, spec: { ...context.base.spec, conversationId: "c1", isolation: { plan } } } };
};

test("the repositories' turn checks are bound to an isolated conversation's turn, and only when one is declared", async () => {
    const deps = depsHolding(undefined);
    expect(harnessHooks(deps, await isolated(), [], TURN_CHECKS).turnChecks?.rules).toEqual(TURN_CHECKS);
    expect(Object.keys(harnessHooks(deps, await isolated(), [], []))).not.toContain("turnChecks");
    // The shared tree carries everyone's uncommitted work, so a check of it would charge this turn with theirs.
    expect(Object.keys(harnessHooks(deps, context, [], TURN_CHECKS))).not.toContain("turnChecks");
});

test("a conversation the registry does not hold, or one in the shared tree, changed nothing a turn check could judge", async () => {
    const shared = unstubbed<PersistedAgent>("agent", { placement: { kind: "main" } });
    for (const entry of [undefined, shared]) {
        const checks = harnessHooks(depsHolding(entry), await isolated(), [], TURN_CHECKS).turnChecks;
        expect(await checks?.change()).toEqual({ paths: [], repos: [] });
    }
});

test("each hook callback's time is filed under hook.<event>, with the tool it held and the conversation", async () => {
    const spans: { op: string; ms: number; fields: unknown }[] = [];
    const deps = {
        ...depsHolding(undefined),
        perf: unstubbed<Services["perf"]>("perf", { record: (op, ms, fields) => void spans.push({ op, ms, fields }) }),
    };
    harnessHooks(deps, await isolated(), [], []).hookTimed?.("PreToolUse", 1200, { matcher: "Bash", at: 3, tool: "Bash" });
    expect(spans).toEqual([{ op: "hook.PreToolUse", ms: 1200, fields: { matcher: "Bash", at: 3, tool: "Bash", conversation: "c1" } }]);
});
