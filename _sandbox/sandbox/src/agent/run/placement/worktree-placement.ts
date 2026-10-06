import type { AgentEvent, RepoBase, SnapshotTurn } from "@intentic/sandbox-contract";
import { settleIndex } from "@intentic/base/git";
import { type RepoSync, syncConversation } from "../../../conversations/land/sync.js";
import { agentRepoReview, anchorOf } from "../../../conversations/land/agent-changes.js";
import { headSha } from "../../../git/changes/changes.js";
import { followedParent, landTargetOf, type Upstream, upstreamOf, underLeases } from "../../../conversations/land/land-target.js";
import { isIsolated, worktreeOf } from "../../../conversations/registry/agents-store.js";
import type { ConversationWorktree } from "../../../conversations/worktrees/worktrees.js";
import { carryStrayWork, type RefSnapshot, snapshotRefs } from "../../../conversations/worktrees/stray-work.js";
import type { Services } from "../../../composition.js";
import { forkWorktreeBase } from "../../checkpoints/checkpoint-worktree.js";
import type { TurnInput } from "../../../seams/turn-starter.js";
import { type LandBooks, type LandingDeps, type LandingHooks, landTurn, settleLandBooks } from "./turn-landing.js";
import { anchorIsolatedTurn, type Placement } from "./turn-placement.js";
import type { ReachWatch } from "./turn-reach.js";

// An isolated conversation's own worktree: composed and rebased onto today's main line before the model reads it,
// rebased again whenever a parked card settles and once more before the land, and announced each time it moves. A
// spawned child cut from its parent's checkout is rebased onto that checkout instead (land-target.ts).

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

const MAIN_LINE: Upstream = { kind: "main" };

// What the conversation's branch follows right now: read fresh, since a parent can be archived between two syncs.
const upstreamNow = async (deps: Pick<Services, "agents" | "agentWorktrees">, conversationId: string): Promise<Upstream> => {
    const current = deps.agents.entry(conversationId);
    return current === undefined || !isIsolated(current) ? MAIN_LINE : upstreamOf(current, await landTargetOf(deps, current));
};

// Rebases the conversation's repos onto their upstream, remembering where each moved repo now sits (`onto`) and
// restarting its span there, since a mid-turn rebase orphans the span's sha. Timed, since a rebase and a merge-base
// check differ by orders of magnitude and an unmeasured one would misattribute a slow start. Takes no lease itself: a
// land already holds them, and every other caller runs it under `underLeases`.
const rebaser =
    (
        deps: Pick<Services, "agents" | "perf" | "agentWorktrees">,
        conversationId: string,
        worktree: ConversationWorktree,
        onto: Map<string, string>,
        books: LandBooks,
    ) =>
    async (upstream: Upstream): Promise<RepoSync[]> => {
        // Read fresh every call, since a land in between moves `landedTip`, and a sync onto a parent moves `base`.
        const current = deps.agents.entry(conversationId);
        const recorded = new Map((worktreeOf(current)?.repos ?? []).map((composed) => [composed.repo, composed]));
        const synced = await deps.perf.track("agent.sync", { id: conversationId }, () =>
            syncConversation(
                deps.agentWorktrees,
                conversationId,
                worktree.repos.map(({ repo, base }) => ({ repo, base: recorded.get(repo)?.base ?? base, landedTip: recorded.get(repo)?.landedTip })),
                current?.social.title?.text,
                upstream,
            ),
        );
        const moved = synced.filter((repo) => repo.blocked !== true);
        if (moved.length === 0) {
            return synced;
        }
        for (const repo of moved) {
            onto.set(repo.repo, repo.onto);
        }
        // `base` is where the branch sits on its upstream; stale, it reads a fast-forward as real work.
        await deps.agents.recordWorktree(
            conversationId,
            // oxlint-disable-next-line oxc/no-map-spread -- Each route returns a fresh immutable record.
            (worktreeOf(deps.agents.entry(conversationId))?.repos ?? worktree.repos).map((composed) => ({ ...composed, base: onto.get(composed.repo) ?? composed.base })),
        );
        books.span = books.span.map((repo) => ({ repo: repo.repo, from: onto.get(repo.repo) ?? repo.from, dir: repo.dir }));
        return synced;
    };

// Where a repo stood before this turn, as a commit its branch descends from: where a rebase this turn moved it, else
// its last land's tip while the branch still descends from it, else where the branch sits on main (checkpointOf, the
// anchor the review measures from too). A last tip a rebase by hand orphaned is no such commit: measuring from one
// would charge the land with everything main had gained since.
const spanFrom = async (
    deps: Pick<Services, "agentWorktrees">,
    conversationId: string,
    recorded: { readonly repo: string; readonly base: string; readonly landedTip: string | undefined; readonly parent: string | undefined },
    onto: ReadonlyMap<string, string>,
): Promise<string> => {
    const moved = onto.get(recorded.repo);
    if (moved !== undefined) {
        return moved;
    }
    const fallback = recorded.landedTip ?? recorded.base;
    const dir = deps.agentWorktrees.worktreeDir(conversationId, recorded.repo);
    try {
        const tip = await headSha(dir);
        return tip === undefined
            ? fallback
            : await anchorOf({ parent: recorded.parent }, dir, deps.agentWorktrees.mainDir(recorded.repo), tip, recorded.landedTip, recorded.base);
    } catch {
        // allow(silent-catch): a checkout git cannot read keeps the recorded anchor, as every turn before this did.
        return fallback;
    }
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

// Carries what the turn committed on a branch of its own back onto `agent/<id>` (stray-work.ts), under the
// conversation's land lease so a land pressed meanwhile queues behind it rather than reading the branch mid-move. Never
// throws: work it could not carry stays where the agent left it, and the review says so.
const carryStray = async (deps: LandingDeps, conversationId: string, repos: ConversationWorktree["repos"], snapshot: RefSnapshot): Promise<void> => {
    try {
        const carries = await deps.conversations.withLandLease(conversationId, () => carryStrayWork(deps.agentWorktrees, conversationId, repos, snapshot));
        for (const carry of carries) {
            if (carry.refused !== undefined) {
                deps.logger.warn({ id: conversationId, ...carry }, "agents: work on a branch of its own could not be carried to the conversation's branch");
            } else if (carry.carried > 0) {
                deps.logger.info({ id: conversationId, ...carry }, "agents: carried a turn's commits off a branch of its own");
            }
        }
    } catch (error) {
        deps.logger.warn({ err: error, id: conversationId }, "agents: carrying work off a branch of its own failed");
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
    turn: {
        readonly input: TurnInput;
        readonly conversationId: string;
        readonly snapshot: SnapshotTurn;
        readonly signal: AbortSignal | undefined;
        // Where the turn's work went besides its branch: installs read once its copy is composed, the rest at the close.
        readonly reach?: ReachWatch;
    },
    steps: WorktreeSteps,
): Placement => {
    const { input, conversationId } = turn;
    const books: LandBooks = { span: [], branch: "", outcome: undefined, reconciled: false };
    // Workflow steps stay on the run's snapshot; rebasing would reintroduce the removed race.
    const pinned = input.worktreeBase !== undefined;
    // Nothing to rebase until the worktree is composed, and never for a pinned step.
    let rebase = async (_upstream: Upstream): Promise<RepoSync[]> => [];
    // A rebase outside the land, under the leases of every checkout it reads and writes (land-target.ts).
    const rebaseLeased = async (): Promise<RepoSync[]> => {
        const upstream = await upstreamNow(deps, conversationId);
        return underLeases(deps.conversations, conversationId, followedParent(upstream), () => rebase(upstream));
    };
    // The refs as the turn opened, once its copy is composed and synced: what tells the turn's own commits on a branch
    // it switched to from that branch's history. Carried once per turn, before a clean turn's land and in any turn's close.
    let opened: { readonly repos: ConversationWorktree["repos"]; readonly refs: RefSnapshot } | undefined;
    let carried: Promise<void> | undefined;
    const carryOnce = (): Promise<void> => {
        if (opened !== undefined) {
            carried ??= carryStray(deps, conversationId, opened.repos, opened.refs);
        }
        return carried ?? Promise.resolve();
    };
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
            const synced = await rebaseLeased();
            opened = { repos: worktree.repos, refs: await snapshotRefs(deps.agentWorktrees, worktree.repos) };
            void turn.reach?.open();
            books.branch = worktree.branch;
            books.span = await Promise.all(
                worktree.repos.map(async ({ repo, base }) => ({
                    repo,
                    from: await spanFrom(
                        deps,
                        conversationId,
                        {
                            repo,
                            base,
                            landedTip: worktreeOf(entry)?.repos.find((recorded) => recorded.repo === repo)?.landedTip,
                            parent: worktreeOf(deps.agents.entry(conversationId))?.parent,
                        },
                        onto,
                    ),
                    dir: deps.agentWorktrees.worktreeDir(conversationId, repo),
                })),
            );
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
                    const moved = await rebaseLeased();
                    return moved.length === 0 ? undefined : worktreeFrame(worktree, onto, enforced, moved);
                } catch (error) {
                    deps.logger.warn({ err: error, id: conversationId }, "agents: sync on a settled card failed");
                    return undefined;
                }
            };
            return steps.run({ id: conversationId, cwd: worktree.cwd, fenced: worktree.fenced, synced, resync });
        },
        async *land(failed, awaiting) {
            await carryOnce();
            yield* landTurn(
                deps,
                steps,
                {
                    conversationId,
                    prompt: input.prompt,
                    autoLand: input.autoLand,
                    failed,
                    aborted: turn.signal?.aborted === true,
                    awaitingWake: awaiting,
                    sync: (upstream) => rebase(upstream),
                },
                books,
            );
        },
        // A person-ended turn skipped the land, so its books are settled here; an errored one is left as it is. Its
        // commits on a branch of its own are carried either way, so the review shows them.
        close: async (failed) => {
            await carryOnce();
            if (!books.reconciled && !failed) {
                await settleLandBooks(deps, conversationId);
            }
            // Clones are read in the checkouts the turn opened on; one that never came up has none to strand.
            await turn.reach?.close((opened?.repos ?? []).map(({ repo }) => ({ repo, dir: deps.agentWorktrees.worktreeDir(conversationId, repo) })));
        },
        // Once per turn, whatever the outcome; an empty span means the worktree never came up.
        settled: (ending) => {
            if (books.span.length === 0) {
                return;
            }
            const title = deps.agents.entry(conversationId)?.social.title?.text;
            deps.events.publish("workspace", {
                event: "turn.settled",
                agentId: conversationId,
                ...(title !== undefined ? { title } : {}),
                branch: books.branch,
                outcome: ending === "failed" ? "error" : (books.outcome ?? "idle"),
                repos: books.span,
            });
            warmReview(deps, conversationId);
        },
        thrown: "agent turn failed",
    };
};
