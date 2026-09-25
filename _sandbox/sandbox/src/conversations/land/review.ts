import type {
    AgentChange,
    AgentChanges,
    AgentHistoryCommit,
    AgentRepoChanges,
    AgentRepoHistory,
    LandConflict,
    ScratchPath,
} from "@intentic/sandbox-contract";
import type { Services } from "../../composition.js";
import { headSha } from "../../git/changes/changes.js";
import type { IsolatedAgent, RepoRecord } from "../registry/agents-store.js";
import { agentRepoModules, agentRepoReview, checkpointOf, presentInMain } from "./agent-changes.js";
import { outstandingConflicts } from "./land.js";
import { commitsCarrying, historySpanStart } from "./landed-history.js";

// What a conversation's review reads, against main as it stands: the rows still its own, what main absorbed, the scratch
// its live copy keeps, the conflicts a land would meet, and the commits that carried what already landed.

export type ReviewDeps = Pick<Services, "agentWorktrees" | "logger">;

// The review's `scratch`: repos with none left out, and the field absent when no repo has any.
const scratchField = (scratch: NonNullable<AgentChanges["scratch"]>): Pick<AgentChanges, "scratch"> => {
    const some = scratch.filter((repo) => repo.paths.length > 0);
    return some.length > 0 ? { scratch: some } : {};
};

// One repo's part of a review: its rows, how many main has absorbed, and the scratch its live copy keeps.
const repoReviewOf = async (
    deps: ReviewDeps,
    entry: IsolatedAgent,
    composed: RepoRecord,
): Promise<{ readonly row?: AgentRepoChanges; readonly absorbed: number; readonly scratch: ScratchPath[] }> => {
    try {
        // Same reading agent-changes.ts uses for the land's totals, so the two cannot disagree.
        const review = await agentRepoReview(deps.agentWorktrees, entry, composed);
        // Before the empty check: a conversation that wrote nothing but scratch still has something to show.
        const { changes, scratch } = review;
        if (changes.length === 0) {
            return { absorbed: 0, scratch };
        }
        const present = await presentInMain(
            deps.agentWorktrees,
            entry,
            composed,
            changes.map((change) => change.path),
        );
        // Object.assign, not a spread: `changes` is this call's own array, so nothing needs copying.
        const flagged = changes
            .filter((change) => !present.absorbed.has(change.path))
            .map((change): AgentChange => Object.assign(change, { landed: present.inWorkspace.has(change.path) }));
        if (flagged.length === 0) {
            return { absorbed: present.absorbed.size, scratch };
        }
        // Reads the worktree's own layout; /workspace/modules walks /work, missing a new package.
        const modules = await agentRepoModules(deps.agentWorktrees, entry, composed.repo);
        return { row: { repo: composed.repo, branch: entry.placement.branch, changes: flagged, modules }, absorbed: present.absorbed.size, scratch };
    } catch (error) {
        // One broken worktree (mid-repair, deleted dir) must not 500 the whole review.
        deps.logger.warn({ err: error, repo: composed.repo, id: entry.id }, "agents diff: repo skipped");
        return { absorbed: 0, scratch: [] };
    }
};
// Re-derived, not replayed: the stored refusal is from land time, rows may since be committed. Served as stored
// while a land holds one of its repos, since re-deriving would queue this read behind that land.
export const liveConflicts = async (deps: ReviewDeps, entry: IsolatedAgent): Promise<LandConflict[]> =>
    entry.landing.conflicts === undefined
        ? []
        : entry.placement.repos.some(({ repo }) => deps.agentWorktrees.repoBusy(repo))
          ? entry.landing.conflicts
          : await outstandingConflicts(deps.agentWorktrees, entry);
// What a conversation's review shows right now, its repos read side by side and kept in composition order.
export const reviewOf = async (deps: ReviewDeps, entry: IsolatedAgent): Promise<AgentChanges> => {
    const parts = await Promise.all(entry.placement.repos.map((composed) => repoReviewOf(deps, entry, composed)));
    const repos = parts.flatMap((part) => (part.row === undefined ? [] : [part.row]));
    const absorbed = parts.reduce((total, part) => total + part.absorbed, 0);
    const scratch = entry.placement.repos.map((composed, index) => ({ repo: composed.repo, paths: parts[index]?.scratch ?? [] }));
    const conflicts = await liveConflicts(deps, entry);
    // Asked of the whole composition, not of the repos that produced rows: a conversation that did all its work
    // on a branch of its own leaves `agent/<id>` empty, which is the case with no row to hang this on.
    const elsewhere = await deps.agentWorktrees.elsewhere(entry.id, entry.placement.repos);
    // Tells apart an agent that wrote nothing from one whose every file is committed (AgentChangesSchema).
    return {
        repos,
        absorbed,
        ...scratchField(scratch),
        ...(conflicts.length > 0 ? { conflicts } : {}),
        ...(elsewhere.length > 0 ? { elsewhere: elsewhere.map(({ repo, branch }) => ({ repo, ...(branch === undefined ? {} : { branch }) })) } : {}),
    };
};

// Reads the same rows the review filters out to absorbed, from the same pass over the tree, so the two can't disagree.
// Span starts at the recorded `landedHead` when it still resolves, else the merge-base anchor.
export const historyOf = async (deps: ReviewDeps, entry: IsolatedAgent): Promise<{ repos: AgentRepoHistory[]; unaccounted: number }> => {
    const repos: AgentRepoHistory[] = [];
    let unaccounted = 0;
    for (const composed of entry.placement.repos) {
        try {
            const { changes } = await agentRepoReview(deps.agentWorktrees, entry, composed);
            if (changes.length === 0) {
                continue;
            }
            const present = await presentInMain(
                deps.agentWorktrees,
                entry,
                composed,
                changes.map((change) => change.path),
            );
            // Nothing of this repo's work is in history yet; the common case, and free to check.
            const absorbed = changes.filter((change) => present.absorbed.has(change.path));
            if (absorbed.length === 0) {
                continue;
            }
            const main = deps.agentWorktrees.mainDir(composed.repo);
            const head = await headSha(main);
            if (head === undefined) {
                unaccounted += absorbed.length;
                continue;
            }
            // Anchor read only when the recorded head can't serve: rare, saves a merge-base spawn.
            const landed = composed.landedHead === undefined ? undefined : await historySpanStart(main, composed.landedHead, head);
            const from = landed ?? (await checkpointOf(main, main, entry.placement.branch, undefined, composed.base));
            const byPath = new Map(absorbed.map((change) => [change.path, change]));
            const commits: AgentHistoryCommit[] = [];
            let placed = 0;
            for (const commit of await commitsCarrying(
                main,
                from,
                head,
                absorbed.map((change) => change.path),
            )) {
                const rows = commit.paths.flatMap((path) => {
                    const row = byPath.get(path);
                    return row === undefined ? [] : [row];
                });
                if (rows.length === 0) {
                    continue;
                }
                placed += rows.length;
                commits.push({
                    sha: commit.sha,
                    short: commit.short,
                    subject: commit.subject,
                    author: commit.author,
                    at: commit.at,
                    changes: rows,
                });
            }
            // Absorbed but placed nowhere: reached main by a road other than a commit in this span.
            unaccounted += absorbed.length - placed;
            if (commits.length === 0) {
                continue;
            }
            const modules = await agentRepoModules(deps.agentWorktrees, entry, composed.repo);
            repos.push({ repo: composed.repo, commits, modules });
        } catch (error) {
            // One unreadable repo must not take down the others, same reasoning as the review above.
            deps.logger.warn({ err: error, repo: composed.repo, id: entry.id }, "agents history: repo skipped");
        }
    }
    return { repos, unaccounted };
};
