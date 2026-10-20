import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { Rule } from "@intentic/sandbox-contract/schemas/settings";
import type { WorkspaceEvent } from "@intentic/sandbox-contract/schemas/automations";
import { landAgent, type LandOutcome } from "./land.js";
import { reportLandRepairs } from "./rederive.js";
import { landFailureOf } from "./land-failure.js";
import { intoOf, type LandTarget, landTargetOf, type Upstream, upstreamOf, underLeases } from "./land-target.js";
import { landingPaths } from "./landing-paths.js";
import { noteLandHeldForWake } from "./wake-held.js";
import { versionCommitsSettled, versionProjectFolders } from "./version-landed.js";
import { type IsolatedAgent, isIsolated } from "../registry/agents-store.js";
import type { Services } from "../../composition.js";
import { landingVerdict, type RuleFacts, standing } from "../../rules/rules.js";
import type { DependencyLandOrigin } from "../../workspace/deps/dependency-origin.js";
import type { ReconcileOutcome } from "../../workspace/deps/reconcile-deps.js";
import { opt } from "../../opt.js";

// A finished isolated turn's land, step 4 of the turn's close (turn-close.ts). Whether its work reaches the main tree or
// waits on its branch is decided purely, from the rules and the paths it touched; no check holds it, and none runs after
// it either: CI checks what the owner pushes. The land runs as the sequence below: decide, land under the lease (which
// writes the repository's derived files again where the work lands, rederive.ts), record, reconcile the installed
// tree, announce. A spawned child's work goes
// into its parent's checkout instead (land-target.ts), as the parent's in-process subagents' edits do: no rule decides
// that, and nothing of the main tree's after-land (its version commit, its installed tree, its announcements) follows.

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
    ...opt("into", landed.into),
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
    "agents" | "conversations" | "sandboxSettings" | "agentWorktrees" | "logger" | "perf" | "activity" | "ruleFirings" | "events" | "dependencies"
>;

// The hand-off a land makes that needs the whole daemon, bound by the caller that has it.
export interface LandingHooks {
    // Drafts what a land did and commits it where the version rule stands, off the turn's clock.
    readonly settleLanding: (conversationId: string) => void;
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
    // The rebase onto the branch's upstream (today's main line, or a child's parent's checkout), run once more under the
    // lease since the top-of-turn one is stale by now.
    readonly sync: (upstream: Upstream) => Promise<unknown>;
}

// Keeps a land that broke on the card (AgentSummary.landFailure). Never throws, so the error the land itself ended on
// is still what its caller reports.
// `check`: the end-of-turn check that measures held work broke, not a land (AgentsRegistry.recordLandFailure).
export const keepLandFailure = async (deps: Pick<Services, "agents" | "logger">, conversationId: string, cause: unknown, check = false): Promise<void> => {
    try {
        await deps.agents.recordLandFailure(conversationId, { ...landFailureOf(cause), ...(check ? { check: true } : {}) });
    } catch (recording) {
        deps.logger.warn({ err: recording, id: conversationId }, "agents: keeping a broken land on its card failed");
    }
};

export const performLandingWrites = (deps: Pick<Services, "activity" | "ruleFirings" | "logger">, conversationId: string, writes: readonly LandingWrite[]): void => {
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
const landUnderLease = async (
    deps: LandingDeps,
    turn: LandingTurn,
    finished: IsolatedAgent,
    mode: LandingDecision["mode"],
    target: LandTarget,
): Promise<LandOutcome> => {
    const id = turn.conversationId;
    // Another agent's land still waiting on its version commit reads as the owner's uncommitted edits; rebased and
    // judged after that commit instead, it is history this branch can merge with. A parent's checkout has no such commit.
    if (target.kind === "main") {
        const repos = finished.placement.repos.map(({ repo }) => repo);
        await versionCommitsSettled(deps, repos);
        // What file sync delivered since the turn opened, committed so the rebase below reaches it (version-landed.ts).
        await versionProjectFolders(deps, repos);
    }
    try {
        await turn.sync(upstreamOf(finished, target));
    } catch (error) {
        deps.logger.warn({ err: error, id }, "agents: pre-land sync failed, landing on the old base");
    }
    const resynced = deps.agents.entry(id);
    const landing = resynced !== undefined && isIsolated(resynced) ? resynced : finished;
    const outcome = await deps.perf.track("agent.land", { id, mode, span: "outstanding" }, () =>
        landAgent(deps.agentWorktrees, landing, mode, "outstanding", intoOf(target)),
    );
    reportLandRepairs(deps.logger, id, outcome);
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
// the tree, reported, and announced. One into a parent's checkout is recorded and framed only: the main tree did not
// move, and the parent's own land is what reaches it.
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
    if (landed.into !== undefined) {
        yield landedFrame(landed, undefined);
        await settleParentBooks(deps, landed);
        return;
    }
    if (landed.landed) {
        hooks.settleLanding(id);
    }
    // The moment a dependency change starts costing every later turn's node_modules.
    const origin: DependencyLandOrigin = { kind: "land", agentId: id, ...opt("title", finished.social.title?.text), branch: books.branch, repos: books.span };
    const reconciled = landed.landed ? await deps.dependencies.reconcileLand(origin) : undefined;
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

// A parent's card reads its branch: what a child just put into its checkout is committed there and measured, as an ended
// turn's own work is, so a parent at rest reads what it now holds. A parent whose own turn is live does that at its land.
export const settleParentBooks = async (
    deps: Pick<Services, "agents" | "conversations" | "perf" | "agentWorktrees" | "logger">,
    landed: { readonly into?: string | undefined; readonly landed: boolean },
): Promise<void> => {
    if (landed.into !== undefined && landed.landed && !deps.conversations.running(landed.into)) {
        await settleLandBooks(deps, landed.into);
    }
};

// What lands with no rule to ask: a child's work into its parent, as the parent's in-process subagents' edits go there.
const UNRULED: LandingDecision = { mode: "check", writes: [] };

/**
 * Whether a finished turn's work lands by itself, going where `target` says: what the sandbox's landing rules say of work
 * reaching the owner's tree, `autoLand` being the turn's own answer (the conversation's posture where it gave none); a
 * child's work into its parent's checkout asks no rule. The one decision a turn's close and a land its wake held
 * (wake-held-land.ts) both make.
 */
export const decideLanding = async (
    deps: Pick<Services, "sandboxSettings" | "agentWorktrees" | "logger">,
    target: LandTarget,
    finished: IsolatedAgent,
    autoLand: boolean | undefined,
    span: LandBooks["span"],
): Promise<LandingDecision> => {
    if (target.kind !== "main" || !target.ruled) {
        return UNRULED;
    }
    const { rules } = await deps.sandboxSettings.get();
    const facts = await landingFacts(deps, rules, finished, span);
    return landingDecision(rules, facts, autoLand ?? finished.postures.autoLand);
};

// Lands a clean turn, or runs the same pass in `measure` where it is held; nothing at all for a failed or stopped one,
// nor for one that ended to wait on something it armed, whose wake is the turn that finishes the work.
export async function* landTurn(deps: LandingDeps, hooks: LandingHooks, turn: LandingTurn, books: LandBooks): AsyncGenerator<AgentEvent> {
    const id = turn.conversationId;
    const finished = deps.agents.entry(id);
    const isolated = finished !== undefined && isIsolated(finished);
    // A clean turn that ended to wait on its own wake skips its land, kept for if that wake goes away without firing
    // (wake-held-land.ts); any other ending clears what an earlier one kept.
    const heldForWake = !turn.failed && !turn.aborted && turn.awaitingWake && isolated;
    // On the record, since the wake it waits on outlives a restart.
    await noteLandHeldForWake(deps, id, heldForWake ? opt("autoLand", turn.autoLand) : undefined);
    if (turn.failed || turn.aborted || turn.awaitingWake || !isolated) {
        return;
    }
    const target = await landTargetOf(deps, finished);
    const decision = await decideLanding(deps, target, finished, turn.autoLand, books.span);
    // Under the land lease, so a manual land pressed meanwhile queues rather than rebasing under this one; and under the
    // parent's too where the work goes into its checkout. A land that breaks still fails the turn, and stays on the card
    // after the next turn clears that failure, until a land goes through.
    const landed = await underLeases(deps.conversations, id, intoOf(target), () => landUnderLease(deps, turn, finished, decision.mode, target)).catch(
        async (cause: unknown) => {
            await keepLandFailure(deps, id, cause);
            throw cause;
        },
    );
    books.reconciled = true;
    performLandingWrites(deps, id, decision.writes);
    if (landed.changed) {
        yield* recordLand(deps, hooks, turn, finished, books, landed);
        return;
    }
    // A tip that moved with nothing written (a net-zero delta: an edit and its revert) is kept on the books but never
    // announced: "Changes landed" over an empty tree is a land the owner then cannot find.
    if (landed.advanced === true) {
        await deps.agents.recordLanded(id, landed);
    }
    // Nothing new to land, but earlier output already counts: it stays landed rather than dropping to idle.
    books.outcome = landed.diff.files > 0 ? "landed" : books.outcome;
}

// Everything the end-of-turn pass does except land on the main tree, for a turn that skipped that pass: in `measure`
// mode, and never fatal, since this runs after the turn has already ended.
export const settleLandBooks = async (
    deps: Pick<Services, "agents" | "conversations" | "perf" | "agentWorktrees" | "logger">,
    conversationId: string,
): Promise<void> => {
    const entry = deps.agents.entry(conversationId);
    if (entry === undefined || !isIsolated(entry)) {
        return;
    }
    try {
        // Measured against where its work goes: a child's parent's checkout already holding it is a land, not a hold.
        const into = intoOf(await landTargetOf(deps, entry));
        const measured = await deps.conversations.withLandLease(conversationId, () =>
            deps.perf.track("agent.land", { id: conversationId, mode: "measure", span: "outstanding" }, () =>
                landAgent(deps.agentWorktrees, entry, "measure", "outstanding", into),
            ),
        );
        reportLandRepairs(deps.logger, conversationId, measured);
        if (measured.changed || measured.advanced === true) {
            await deps.agents.recordLanded(conversationId, measured);
        }
        // Read this time: what an earlier check could not read (a passing index.lock) no longer stands on the card.
        await deps.agents.clearCheckFailure(conversationId);
    } catch (error) {
        deps.logger.warn({ err: error, id: conversationId }, "agents: settling an ended turn's land books failed");
        // A checkout its books cannot be read from is one no land can carry either: said on the card, not only in the log,
        // or it rests on the standing git reads off the main repo, which is `landed` for a branch that never moved there.
        await keepLandFailure(deps, conversationId, error, true);
    }
};
