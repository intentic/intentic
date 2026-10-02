import type {
    AgentChange,
    AgentChanges,
    AgentHistoryCommit,
    AgentRepoChanges,
    AgentRepoHistory,
    LandConflict,
    ScratchPath,
} from "@intentic/sandbox-contract";
import { defaultGit } from "@intentic/scaffold";
import type { Services } from "../../composition.js";
import { headSha } from "../../git/changes/changes.js";
import { materializedPaths } from "../../git/changes/changes-porcelain.js";
import type { IsolatedAgent, RepoRecord } from "../registry/agents-store.js";
import { strayStandings } from "../worktrees/stray-work.js";
import { agentRepoChanges, agentRepoModules, agentRepoReview, anchorOf, presentInMain } from "./agent-changes.js";
import { intoOf, landTargetOf } from "./land-target.js";
import { dirtyPaths, outstandingConflicts } from "./land.js";
import { commitsCarrying, historySpanStart } from "./landed-history.js";

// What a conversation's review reads, against main as it stands: the rows still its own, what main absorbed, the scratch
// its live copy keeps, the conflicts a land would meet, and the commits that carried what already landed.

export type ReviewDeps = Pick<Services, "agentWorktrees" | "agents" | "logger">;

// The review's `scratch`: repos with none left out, and the field absent when no repo has any.
const scratchField = (scratch: NonNullable<AgentChanges["scratch"]>): Pick<AgentChanges, "scratch"> => {
    const some = scratch.filter((repo) => repo.paths.length > 0);
    return some.length > 0 ? { scratch: some } : {};
};

const NONE: ReadonlySet<string> = new Set();

// Rows the last land already took that main has edited again since: main holds neither the agent's content nor anything
// a land could still apply, so reading presence alone offered Land now for a land that carries nothing, while the board,
// reading the land's own record, already called the agent landed. Taken means outside the outstanding span (what a land
// applies: `landedTip` to the tip, uncommitted work included) and still in main the way landed-presence.ts reads it:
// touched in history since the land's HEAD, or uncommitted in the tree. Work taken out of the tree after the land is
// neither, so it stays outstanding and keeps its Land again. A child that landed into its parent's checkout has no land
// in main to read, and a failed read answers nothing: the row keeps what presence said.
const takenByLastLand = async (
    deps: ReviewDeps,
    entry: IsolatedAgent,
    composed: RepoRecord,
    paths: readonly string[],
): Promise<ReadonlySet<string>> => {
    const { landedTip, landedHead } = composed;
    if (paths.length === 0 || landedTip === undefined || landedHead === undefined || entry.placement.landedInto !== undefined) {
        return NONE;
    }
    try {
        const main = deps.agentWorktrees.mainDir(composed.repo);
        const head = await headSha(main);
        if (head === undefined) {
            return NONE;
        }
        const [outstanding, committed, dirty] = await Promise.all([
            agentRepoChanges(deps.agentWorktrees, entry, composed, "outstanding"),
            defaultGit(main, ["diff", "--name-only", "--no-renames", "-z", landedHead, head]).then(
                ({ stdout }) => new Set(materializedPaths(stdout)),
            ),
            dirtyPaths(main, defaultGit),
        ]);
        const remaining = new Set(outstanding.flatMap((change) => (change.from === undefined ? [change.path] : [change.path, change.from])));
        return new Set(paths.filter((path) => !remaining.has(path) && (committed.has(path) || dirty.has(path))));
    } catch (error) {
        deps.logger.debug({ err: error, repo: composed.repo, id: entry.id }, "agents diff: last land unreadable");
        return NONE;
    }
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
        const kept = changes.filter((change) => !present.absorbed.has(change.path));
        const taken = await takenByLastLand(
            deps,
            entry,
            composed,
            kept.filter((change) => !present.inWorkspace.has(change.path)).map((change) => change.path),
        );
        // Object.assign, not a spread: `changes` is this call's own array, so nothing needs copying.
        const flagged = kept.map((change): AgentChange =>
            Object.assign(change, { landed: present.inWorkspace.has(change.path) || taken.has(change.path) }),
        );
        if (flagged.length === 0) {
            return { absorbed: present.absorbed.size, scratch };
        }
        const [modules, added] = await Promise.all([
            // Reads the worktree's own layout; /workspace/modules walks /work, missing a new package.
            agentRepoModules(deps.agentWorktrees, entry, composed.repo),
            // Of the rows still its own: a manifest your history already carries is no longer something to approve.
            review.addedDependencies(flagged),
        ]);
        const row: AgentRepoChanges = { repo: composed.repo, branch: entry.placement.branch, changes: flagged, modules };
        // Absent rather than empty, as the contract says: most work adds nothing.
        if (added.length > 0) {
            row.addedDependencies = added;
        }
        return { row, absorbed: present.absorbed.size, scratch };
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
          : await outstandingConflicts(deps.agentWorktrees, entry, intoOf(await landTargetOf(deps, entry)));
// What a conversation's review shows right now, its repos read side by side and kept in composition order.
export const reviewOf = async (deps: ReviewDeps, entry: IsolatedAgent): Promise<AgentChanges> => {
    const parts = await Promise.all(entry.placement.repos.map((composed) => repoReviewOf(deps, entry, composed)));
    const repos = parts.flatMap((part) => (part.row === undefined ? [] : [part.row]));
    const absorbed = parts.reduce((total, part) => total + part.absorbed, 0);
    const scratch = entry.placement.repos.map((composed, index) => ({ repo: composed.repo, paths: parts[index]?.scratch ?? [] }));
    const conflicts = await liveConflicts(deps, entry);
    // Asked of the whole composition, not of the repos that produced rows: a conversation that did all its work
    // on a branch of its own leaves `agent/<id>` empty whenever the turn's carry could not copy it over.
    const elsewhere = await strayStandings(deps.agentWorktrees, entry.id, entry.placement.repos);
    // Tells apart an agent that wrote nothing from one whose every file is committed (AgentChangesSchema).
    return {
        repos,
        absorbed,
        ...scratchField(scratch),
        ...(conflicts.length > 0 ? { conflicts } : {}),
        ...(elsewhere.length > 0 ? { elsewhere } : {}),
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
            const from = landed ?? (await anchorOf(entry.placement, main, main, entry.placement.branch, undefined, composed.base));
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
