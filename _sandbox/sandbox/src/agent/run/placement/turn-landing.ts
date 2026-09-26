import type { AgentEvent, Rule, WorkspaceEvent } from "@intentic/sandbox-contract";
import { landAgent, type LandOutcome, reportLockfileFailures } from "../../../conversations/land/land.js";
import { landingPaths } from "../../../conversations/land/landing-paths.js";
import { type LandVerifier, verifyLandedTree } from "../../../conversations/land/verify-landed.js";
import { versionCommitsSettled } from "../../../conversations/land/version-landed.js";
import { type IsolatedAgent, isIsolated } from "../../../conversations/registry/agents-store.js";
import type { Services } from "../../../composition.js";
import { landingVerdict, type RuleFacts, standing } from "../../../rules/rules.js";
import type { DependencyLandOrigin } from "../../../workspace/deps/dependency-origin.js";
import type { ReconcileOutcome } from "../../../workspace/deps/reconcile-deps.js";
import { opt } from "../../../opt.js";
import type { FixersRepo } from "../../../conversations/land/worktree-fixers.js";

// A finished isolated turn's land, step 4 of the turn's close (turn-close.ts). Whether its work reaches the main tree or
// waits on its branch is decided purely, from the rules and the paths it touched; no check holds it, since checks run
// after the work lands and never block. The land runs as the sequence below: the repository's fixers in the worktree,
// decide, land under the lease, record, verify, announce.

// What the land did, for the turn's `turn.settled` event; the card's standing is derived elsewhere.
export type LandedOutcome = "landed" | "conflict" | "ready";

// A decision's side of the settings feed: a hold is news where a land is self-evident, and the rule that decided is
// stamped as fired.
export type LandingWrite = { readonly kind: "held"; readonly content: string } | { readonly kind: "fired"; readonly rule: string };

export interface LandingDecision {
    // `check` lands what passes; `measure` runs the same pass and leaves the work on its branch.
    readonly mode: "check" | "measure";
    readonly writes: readonly LandingWrite[];
}

// A per-agent override wins over the rules table.
export const landingDecision = (rules: readonly Rule[], facts: RuleFacts, override: boolean | undefined): LandingDecision => {
    const decided = landingVerdict(rules, facts, override);
    const ruled: LandingWrite[] =
        decided.rule === undefined
            ? []
            : [
                  { kind: "fired", rule: decided.rule.id },
                  ...(decided.land ? [] : [{ kind: "held" as const, content: `"${decided.rule.label}" held this work on its branch instead of landing it.` }]),
              ];
    return { mode: decided.land ? "check" : "measure", writes: ruled };
};

// What became of a land that changed something: held on its branch, in the main tree, or in conflict with it.
export const landedOutcomeOf = (landed: LandOutcome): LandedOutcome => {
    if (landed.held === true) {
        return "ready";
    }
    return landed.landed ? "landed" : "conflict";
};

export const landedFrame = (landed: LandOutcome, deps: ReconcileOutcome | undefined): Extract<AgentEvent, { kind: "landed" }> => ({
    kind: "landed",
    landed: landed.landed,
    ...opt("conflicts", landed.conflicts),
    ...(landed.held === true ? { held: true } : {}),
    ...opt("deps", deps),
});

// The turn's books its land shares with its placement: the span a rebase moves, and what the land did.
export interface LandBooks {
    // Where each repo stood before this turn; empty until the worktree came up.
    span: WorkspaceEvent["repos"];
    branch: string;
    outcome: LandedOutcome | undefined;
    // Whether the end-of-turn pass ran; the placement settles the books itself when it didn't.
    reconciled: boolean;
}

export type LandingDeps = Pick<
    Services,
    "agents" | "conversations" | "sandboxSettings" | "agentWorktrees" | "logger" | "perf" | "activity" | "ruleFirings" | "events"
> &
    LandVerifier;

// The hand-off a land makes that needs the whole daemon, bound by the caller that has it.
export interface LandingHooks {
    // Drafts what a land did and commits it where the version rule stands, off the turn's clock.
    readonly settleLanding: (conversationId: string) => void;
    // Runs the repository's own machine fixers in the worktree on what the turn changed (worktree-fixers.ts), so what
    // they write rides this land; never throws.
    readonly fix: (span: readonly FixersRepo[]) => Promise<unknown>;
}

export interface LandingTurn {
    readonly conversationId: string;
    readonly prompt: string;
    readonly autoLand: boolean | undefined;
    // A failed turn must not auto-land half-done work, and a stopped one lands nothing either.
    readonly failed: boolean;
    readonly aborted: boolean;
    // The conversation runs again by itself (turn-close.ts): its wake is the turn that finishes the work, so nothing lands.
    readonly awaitingWake: boolean;
    // The rebase onto today's main line, run once more under the lease since the top-of-turn one is stale by now.
    readonly sync: () => Promise<unknown>;
}

const performLandingWrites = (deps: Pick<Services, "activity" | "ruleFirings" | "logger">, conversationId: string, writes: readonly LandingWrite[]): void => {
    for (const write of writes) {
        if (write.kind === "fired") {
            void deps.ruleFirings.stamp(write.rule, Date.now()).catch((error: unknown) => deps.logger.warn({ err: error }, "rule firing stamp failed"));
        } else {
            void deps.activity
                .append({ direction: "system", type: "rule.held_work", content: write.content, conversationId })
                .catch((error: unknown) => deps.logger.warn({ err: error }, "rule activity append failed"));
        }
    }
};

// Best-effort: a failed rebase lands on the old base. Re-read after it, since the frozen composition would hand the
// checkpoint an orphaned base.
const landUnderLease = async (deps: LandingDeps, turn: LandingTurn, finished: IsolatedAgent, mode: LandingDecision["mode"]): Promise<LandOutcome> => {
    const id = turn.conversationId;
    // Another agent's land still waiting on its version commit reads as the owner's uncommitted edits; rebased and
    // judged after that commit instead, it is history this branch can merge with.
    await versionCommitsSettled(
        deps,
        finished.placement.repos.map(({ repo }) => repo),
    );
    try {
        await turn.sync();
    } catch (error) {
        deps.logger.warn({ err: error, id }, "agents: pre-land sync failed, landing on the old base");
    }
    const resynced = deps.agents.entry(id);
    const landing = resynced !== undefined && isIsolated(resynced) ? resynced : finished;
    const outcome = await deps.perf.track("agent.land", { id, mode, span: "outstanding" }, () => landAgent(deps.agentWorktrees, landing, mode));
    reportLockfileFailures(deps.logger, id, outcome);
    return outcome;
};

// What a land decision reads: the span's repos, and the paths only where a rule narrows by them (a git pass per repo).
// A turn that reached its land ended clean: a failed or stopped one never gets here.
const landingFacts = async (
    deps: Pick<Services, "agentWorktrees" | "logger">,
    rules: readonly Rule[],
    finished: IsolatedAgent,
    span: LandBooks["span"],
): Promise<RuleFacts> => {
    const narrows = standing(rules, "agent.finished").some((rule) => (rule.when?.paths?.length ?? 0) > 0);
    const paths = narrows ? await landingPaths(deps, finished, span) : undefined;
    return { repos: span.map(({ repo }) => repo), paths, outcome: "clean" };
};

// A land that changed something: recorded, verified against the whole repository off the turn's clock where it reached
// the tree, reported, and announced.
async function* recordLand(
    deps: LandingDeps,
    hooks: LandingHooks,
    turn: LandingTurn,
    finished: IsolatedAgent,
    books: LandBooks,
    landed: LandOutcome,
): AsyncGenerator<AgentEvent> {
    const id = turn.conversationId;
    await deps.agents.recordLanded(id, landed);
    books.outcome = landedOutcomeOf(landed);
    if (landed.landed) {
        hooks.settleLanding(id);
    }
    // The moment a dependency change starts costing every later turn's node_modules.
    const origin: DependencyLandOrigin = { kind: "land", agentId: id, ...opt("title", finished.social.title?.text), branch: books.branch, repos: books.span };
    const reconciled = landed.landed ? await verifyLandedTree(deps, origin) : undefined;
    yield landedFrame(landed, reconciled);
    if (!landed.landed) {
        return;
    }
    // The main tree just changed, announced before the land itself: history files its turn checkpoint first.
    deps.events.publish("tree.changed", { label: turn.prompt });
    deps.events.publish("workspace", {
        event: "agent.landed",
        agentId: id,
        ...opt("title", finished.social.title?.text),
        branch: books.branch,
        outcome: "landed",
        repos: books.span,
    });
}

// Lands a clean turn, or runs the same pass in `measure` where it is held; nothing at all for a failed or stopped one,
// nor for one that ended to wait on something it armed, whose wake is the turn that finishes the work.
export async function* landTurn(deps: LandingDeps, hooks: LandingHooks, turn: LandingTurn, books: LandBooks): AsyncGenerator<AgentEvent> {
    const id = turn.conversationId;
    const finished = deps.agents.entry(id);
    if (turn.failed || turn.aborted || turn.awaitingWake || finished === undefined || !isIsolated(finished)) {
        return;
    }
    // Before the decision, so a path a fixer wrote is one the rules read, and before the lease, so the land commits it.
    await hooks.fix(books.span);
    const { rules } = await deps.sandboxSettings.get();
    const facts = await landingFacts(deps, rules, finished, books.span);
    const decision = landingDecision(rules, facts, turn.autoLand ?? finished.postures.autoLand);
    // Under the land lease, so a manual land pressed meanwhile queues rather than rebasing under this one.
    const landed = await deps.conversations.withLandLease(id, () => landUnderLease(deps, turn, finished, decision.mode));
    books.reconciled = true;
    performLandingWrites(deps, id, decision.writes);
    if (landed.changed) {
        yield* recordLand(deps, hooks, turn, finished, books, landed);
        return;
    }
    // Nothing new to land, but earlier output already counts: it stays landed rather than dropping to idle.
    books.outcome = landed.diff.files > 0 ? "landed" : books.outcome;
}
