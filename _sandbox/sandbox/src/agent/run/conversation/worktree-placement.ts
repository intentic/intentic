import type { AgentEvent, RepoBase, SnapshotTurn } from "@intentic/sandbox-contract";
import { settleIndex } from "@intentic/scaffold";
import { type RepoSync, syncConversation } from "../../../agents/land/sync.js";
import { agentRepoReview } from "../../../agents/land/agent-changes.js";
import { isIsolated, worktreeOf } from "../../../agents/registry/agents-store.js";
import type { ConversationWorktree } from "../../../agents/worktrees/worktrees.js";
import type { Services } from "../../../composition.js";
import { forkWorktreeBase } from "../../checkpoints/checkpoint-worktree.js";
import type { TurnInput } from "../../../seams/turn-starter.js";
import { type LandBooks, type LandingDeps, type LandingHooks, landTurn } from "./turn-landing.js";
import { anchorIsolatedTurn, type Placement, settleLandBooks } from "./turn-placement.js";

// An isolated conversation's own worktree: composed and rebased onto today's main line before the model reads it,
// rebased again whenever a parked card settles and once more before the land, and announced each time it moves.

// The worktree a turn runs in, as the turn's body is handed it.
export interface WorktreeRun {
    readonly id: string;
    readonly cwd: string;
    // Whether the checkout was cut to a fence, which the turn's namespace must not hand back.
    readonly fenced: boolean;
    readonly synced: readonly RepoSync[];
    // Re-syncs after a settled card, answering the frame to restate where the branch stands, or nothing if it didn't move.
    readonly resync: () => Promise<AgentEvent | undefined>;
}

export type WorktreeFrame = Extract<AgentEvent, { kind: "worktree" }>;

// Where the branch stands: `base` always names where it sits now, `unenforced` a container rewriting tool paths, and
// `sync` what the rebase that just ran moved or could not.
export const worktreeFrame = (worktree: ConversationWorktree, onto: ReadonlyMap<string, string>, enforced: boolean, synced: readonly RepoSync[]): WorktreeFrame => {
    const root = worktree.repos.find((repo) => repo.repo === "root") ?? worktree.repos[0];
    return {
        kind: "worktree",
        branch: worktree.branch,
        base: (root === undefined ? "" : (onto.get(root.repo) ?? root.base)).slice(0, 7),
        ...(enforced ? {} : { unenforced: true }),
        ...(synced.length > 0
            ? {
                  sync: {
                      commits: synced.filter((repo) => repo.blocked !== true).reduce((total, repo) => total + repo.commits, 0),
                      blocked: synced.filter((repo) => repo.blocked === true).map((repo) => repo.repo),
                  },
              }
            : {}),
    };
};

// Rebases the conversation's repos onto the main line, remembering where each moved repo now sits (`onto`) and
// restarting its span there, since a mid-turn rebase orphans the span's sha. Timed, since a rebase and a merge-base
// check differ by orders of magnitude and an unmeasured one would misattribute a slow start.
const rebaser =
    (
        deps: Pick<Services, "agents" | "perf" | "agentWorktrees">,
        conversationId: string,
        worktree: ConversationWorktree,
        onto: Map<string, string>,
        books: LandBooks,
    ) =>
    async (): Promise<RepoSync[]> => {
        // Read fresh every call, since a land in between moves `landedTip`.
        const current = deps.agents.entry(conversationId);
        const landed = new Map((worktreeOf(current)?.repos ?? []).map((composed) => [composed.repo, composed.landedTip]));
        const synced = await deps.perf.track("agent.sync", { id: conversationId }, () =>
            syncConversation(
                deps.agentWorktrees,
                conversationId,
                worktree.repos.map(({ repo }) => ({ repo, landedTip: landed.get(repo) })),
                current?.social.title?.text,
            ),
        );
        const moved = synced.filter((repo) => repo.blocked !== true);
        if (moved.length === 0) {
            return synced;
        }
        for (const repo of moved) {
            onto.set(repo.repo, repo.onto);
        }
        // `base` is where the branch sits on main; stale, it reads a fast-forward as real work.
        await deps.agents.recordWorktree(
            conversationId,
            // oxlint-disable-next-line oxc/no-map-spread -- Each route returns a fresh immutable record.
            (worktreeOf(deps.agents.entry(conversationId))?.repos ?? worktree.repos).map((composed) => ({ ...composed, base: onto.get(composed.repo) ?? composed.base })),
        );
        books.span = books.span.map((repo) => ({ repo: repo.repo, from: onto.get(repo.repo) ?? repo.from, dir: repo.dir }));
        return synced;
    };

// Every row of the conversation's review counted in the background once a turn settles, so opening the review after it
// reads each code count from cache instead of waiting on a tokenizer.
const warmReview = (deps: Pick<Services, "agents" | "agentWorktrees" | "logger">, conversationId: string): void => {
    const entry = deps.agents.entry(conversationId);
    if (entry === undefined || !isIsolated(entry)) {
        return;
    }
    for (const composed of entry.placement.repos) {
        agentRepoReview(deps.agentWorktrees, entry, composed).catch((error: unknown) =>
            deps.logger.debug({ err: error, id: conversationId, repo: composed.repo }, "agents: counting the review ahead failed"),
        );
    }
};

export interface WorktreeSteps extends LandingHooks {
    // Creates the conversation's worktree on its first turn or repairs its composition, with the repos it carries
    // decided once and handed back on every later turn.
    readonly compose: (base: readonly RepoBase[] | undefined) => Promise<ConversationWorktree>;
    // Commits the owner's own edits on the main tree where the version rule stands: they reach the assistant only as
    // commits, since the rebase reads HEAD.
    readonly versionMain: (repos: readonly string[]) => Promise<unknown>;
    readonly run: (worktree: WorktreeRun) => AsyncIterable<AgentEvent>;
}

export const worktreePlacement = (
    deps: LandingDeps & Pick<Services, "turnCheckpoints" | "turnIsolation">,
    turn: { readonly input: TurnInput; readonly conversationId: string; readonly snapshot: SnapshotTurn; readonly signal: AbortSignal | undefined },
    steps: WorktreeSteps,
): Placement => {
    const { input, conversationId } = turn;
    const books: LandBooks = { span: [], branch: "", outcome: undefined, reconciled: false };
    // Workflow steps stay on the run's snapshot; rebasing would reintroduce the removed race.
    const pinned = input.worktreeBase !== undefined;
    // Nothing to rebase until the worktree is composed, and never for a pinned step.
    let rebase = async (): Promise<RepoSync[]> => [];
    return {
        async *open () {
            const entry = deps.agents.entry(conversationId);
            // A fork wanting the files as they were starts at the source's own commit, for comparability.
            const worktree = await steps.compose(input.worktreeBase ?? (await forkWorktreeBase(deps.turnCheckpoints, input.forkOf)));
            const onto = new Map<string, string>();
            if (!pinned) {
                rebase = rebaser(deps, conversationId, worktree, onto, books);
            }
            // Reported per turn, not once at boot: it depends on how the container launched.
            const enforced = await deps.turnIsolation.available();
            await steps.versionMain(worktree.repos.map(({ repo }) => repo));
            const synced = await rebase();
            books.branch = worktree.branch;
            // Where each repo stood before this turn; a moved repo reads from `onto` instead of `landedTip`.
            books.span = worktree.repos.map(({ repo, base }) => ({
                repo,
                from: onto.get(repo) ?? worktreeOf(entry)?.repos.find((recorded) => recorded.repo === repo)?.landedTip ?? base,
                dir: deps.agentWorktrees.worktreeDir(conversationId, repo),
            }));
            yield worktreeFrame(worktree, onto, enforced, synced);
            // Recorded after the rebase: "before this message" means the branch the agent is about to read.
            yield* anchorIsolatedTurn(deps, conversationId, worktree.repos, turn.snapshot);
            // A fresh checkout, the rebase and the anchor leave racy entries; settled, statuses stop re-reading them.
            for (const { repo } of worktree.repos) {
                settleIndex(deps.agentWorktrees.worktreeDir(conversationId, repo)).catch((error: unknown) =>
                    deps.logger.debug({ err: error, id: conversationId, repo }, "agents: settling a checkout's index failed"),
                );
            }
            // Only a question's picks or an approved plan resync, never a permission card, whose tool call was already
            // computed against the old tree. Must never cost the user their answer: best-effort and logged.
            const resync = async (): Promise<AgentEvent | undefined> => {
                try {
                    const moved = await rebase();
                    return moved.length === 0 ? undefined : worktreeFrame(worktree, onto, enforced, moved);
                } catch (error) {
                    deps.logger.warn({ err: error, id: conversationId }, "agents: sync on a settled card failed");
                    return undefined;
                }
            };
            return steps.run({ id: conversationId, cwd: worktree.cwd, fenced: worktree.fenced, synced, resync });
        },
        land: (failed) =>
            landTurn(
                deps,
                steps,
                { conversationId, prompt: input.prompt, autoLand: input.autoLand, failed, aborted: turn.signal?.aborted === true, sync: () => rebase() },
                books,
            ),
        // A person-ended turn skipped the land, so its books are settled here; an errored one is left as it is.
        close: async (failed) => {
            if (!books.reconciled && !failed) {
                await settleLandBooks(deps, conversationId);
            }
        },
        // Once per turn, whatever the outcome; an empty span means the worktree never came up.
        settled: (failed) => {
            if (books.span.length === 0) {
                return;
            }
            const title = deps.agents.entry(conversationId)?.social.title?.text;
            deps.events.publish("workspace", {
                event: "turn.settled",
                agentId: conversationId,
                ...(title !== undefined ? { title } : {}),
                branch: books.branch,
                outcome: failed ? "error" : (books.outcome ?? "idle"),
                repos: books.span,
            });
            warmReview(deps, conversationId);
        },
        thrown: "agent turn failed",
    };
};
