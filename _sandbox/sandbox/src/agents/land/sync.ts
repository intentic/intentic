import { join } from "node:path";
import { pathExists } from "../../path-exists.js";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { headSha } from "../../git/changes/changes.js";
import { rebaseOnto, rebaseSince } from "../../git/changes/changes-commits.js";
import { AGENT_GIT_AUTHOR } from "../../git/git.js";
import { presenceOf } from "./agent-changes.js";
import { commitWorktreeRemainder } from "../../git/remote/root-repo.js";
import type { AgentWorktrees } from "../worktrees/worktrees.js";

// Rebases a conversation's branch onto main's HEAD before each turn and again before land; a refused rebase retries
// with `--onto main landedTip`, replaying only commits main does not already hold. Touches only this conversation's own
// worktree, never the main checkout; no repo lock is taken.
//
// That retry drops commits, so what main holds is read from main rather than taken from the rung: see
// `mainAccountsForPrefix`.

// A repo whose branch was not on main's tip; `commits` are the main-line commits between the two, gained if rebased,
// still missing if `blocked`.
export interface RepoSync {
    readonly repo: string;
    // Main-line sha the branch now sits on, or failed to reach.
    readonly onto: string;
    readonly commits: number;
    // Paths those commits touched.
    readonly moved: readonly string[];
    // Moved paths this agent also edited; the actionable subset to recheck.
    readonly overlap: readonly string[];
    // The rebase did not apply and was rolled back; the branch is still on its old base.
    readonly blocked?: true;
}

// Paths a span touched, `--no-renames`: `moved` and `mine` below are intersected by path, and a collapsed rename would
// never match on its source side.
const pathsOf = async (dir: string, args: readonly string[], git: GitRunner): Promise<string[]> => {
    const { stdout } = await git(dir, ["diff", "--name-only", "--no-renames", "-z", ...args]);
    return stdout.split("\0").filter((path) => path !== "");
};

// Whether `tip` already contains `head`, via one `merge-base` spawn.
const contains = async (dir: string, tip: string, head: string, git: GitRunner): Promise<boolean> => {
    try {
        await git(dir, ["merge-base", "--is-ancestor", head, tip]);
        return true;
    } catch {
        return false;
    }
};

// Whether main can still account for every path the prefix about to be dropped carries. `landedTip` is bookkeeping, not
// evidence: a land copies content into the main tree and records the rung, and the user can then discard all of it in
// the Changes panel without a single sha moving. A path is accounted for when main still reads the same on it (the
// user committed the land, or it is landed and not yet committed) or when main's own history has moved it since the
// fork, which is the user editing what they landed. One path main has never seen means the land is not there any more:
// the rung is void and the prefix must not be dropped. Asked only after a plain rebase has already refused, so the cost
// falls on the conflict path alone.
const mainAccountsForPrefix = async (
    worktree: string,
    main: string,
    head: string,
    landedTip: string,
    // Main-line movement since divergence, already read for the report; `moved ∩ prefix` is the user's own editing.
    moved: readonly string[],
    git: GitRunner,
): Promise<boolean> => {
    try {
        // Three-dot: the prefix's own side of the fork, so main-line movement is not mistaken for landed work.
        const prefix = await pathsOf(worktree, [`${head}...${landedTip}`], git);
        if (prefix.length === 0) {
            return true;
        }
        const { inWorkspace } = await presenceOf(main, worktree, landedTip, prefix, git);
        const edited = new Set(moved);
        return prefix.every((path) => inWorkspace.has(path) || edited.has(path));
    } catch {
        // A probe that could not run has proven nothing; refusing costs a conflict errand, dropping costs the work.
        return false;
    }
};

// Retries the rebase from `landedTip` only if it is still an ancestor of HEAD and main still holds what it names;
// otherwise nothing has landed, or nothing of it is left, and the refusal stands.
const replayUnlanded = async (
    worktree: string,
    main: string,
    onto: string,
    landedTip: string | undefined,
    moved: readonly string[],
    git: GitRunner,
): Promise<boolean> => {
    if (landedTip === undefined || !(await contains(worktree, "HEAD", landedTip, git))) {
        return false;
    }
    if (!(await mainAccountsForPrefix(worktree, main, onto, landedTip, moved, git))) {
        return false;
    }
    return (await rebaseSince(worktree, onto, landedTip, AGENT_GIT_AUTHOR, git)).ok;
};

const syncOne = async (
    worktrees: AgentWorktrees,
    id: string,
    repo: string,
    // Sha where this repo's work last reached main, from the registry's land bookkeeping.
    landedTip: string | undefined,
    title: string | undefined,
    git: GitRunner,
): Promise<RepoSync | undefined> => {
    const worktree = worktrees.worktreeDir(id, repo);
    // An archived, not yet re-attached checkout has no worktree; skipping is safe, the next attached turn syncs it.
    if (!(await pathExists(join(worktree, ".git")))) {
        return undefined;
    }
    const head = await headSha(worktrees.mainDir(repo), git);
    if (head === undefined) {
        return undefined; // Unborn HEAD, or the main checkout is gone: no main line to sit on.
    }
    const tip = (await git(worktree, ["rev-parse", "HEAD"])).stdout.trim();
    if (tip === head || (await contains(worktree, tip, head, git))) {
        return undefined;
    }
    // Three-dot: main-line movement since divergence, read before the rebase moves `tip`.
    const moved = await pathsOf(worktree, [`${tip}...${head}`], git);
    const mine = new Set(await pathsOf(worktree, [`${head}...${tip}`], git));
    const overlap = moved.filter((path) => mine.has(path));
    const commits = Number((await git(worktree, ["rev-list", "--count", `${tip}..${head}`])).stdout.trim());
    const behind = { repo, onto: head, commits, moved, overlap };
    // Commits the dirty remainder first; `git rebase` refuses to start on a dirty tree.
    await commitWorktreeRemainder(repo, worktree, `Agent: ${title ?? id}`, git);
    if ((await rebaseOnto(worktree, head, AGENT_GIT_AUTHOR, git)).ok) {
        return behind;
    }
    // Refused; retry without the already-landed prefix, the likely cause of the conflict.
    const replayed = await replayUnlanded(worktree, worktrees.mainDir(repo), head, landedTip, moved, git);
    return replayed ? behind : { ...behind, blocked: true };
};

// Syncs every repo of a conversation's composition; returns only repos that were behind, empty when all already sit on
// main's tip. Runs concurrently across repos: separate git dirs and branches, no shared state.
export const syncConversation = async (
    worktrees: AgentWorktrees,
    id: string,
    // Composition; each repo carries the land rung (`landedTip`) the retry needs.
    repos: readonly { readonly repo: string; readonly landedTip?: string | undefined }[],
    title: string | undefined,
    git: GitRunner = defaultGit,
): Promise<RepoSync[]> => {
    const results = await Promise.all(repos.map(({ repo, landedTip }) => syncOne(worktrees, id, repo, landedTip, title, git)));
    return results.filter((result) => result !== undefined);
};

// Re-runs the sync immediately before land, since main can move again mid-turn. Returns the composition with `base`
// moved to each rebased repo's new sha, via the injected `recordWorktree`.
// Structural shape this module needs off a composition row, so it takes no dependency on the registry's store types.
type ComposedRepo = { readonly repo: string; readonly base: string; readonly landedTip?: string | undefined };

export const syncBeforeLand = async <Repo extends ComposedRepo>(
    worktrees: AgentWorktrees,
    entry: { readonly id: string; readonly title?: string | undefined; readonly repos: readonly Repo[] },
    recordWorktree: (id: string, repos: readonly Repo[]) => Promise<void>,
    git: GitRunner = defaultGit,
): Promise<readonly Repo[]> => {
    const synced = await syncConversation(
        worktrees,
        entry.id,
        entry.repos.map(({ repo, landedTip }) => ({ repo, landedTip })),
        entry.title,
        git,
    );
    const onto = new Map(synced.filter((repo) => repo.blocked !== true).map((repo) => [repo.repo, repo.onto]));
    if (onto.size === 0) {
        return entry.repos;
    }
    // oxlint-disable-next-line oxc/no-map-spread -- a fresh record per repo is the point: these are the registry's own persisted rows
    const moved = entry.repos.map((composed): Repo => ({ ...composed, base: onto.get(composed.repo) ?? composed.base }));
    await recordWorktree(entry.id, moved);
    return moved;
};
