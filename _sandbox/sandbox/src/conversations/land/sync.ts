import { join } from "node:path";
import { pathExists } from "@intentic/base/fs";
import { defaultGit, type GitRunner } from "@intentic/base/git";
import { headSha } from "../../git/changes/changes.js";
import { rebaseOnto, rebaseSince } from "../../git/changes/changes-commits.js";
import { AGENT_GIT_AUTHOR, withConversationTrailer } from "../../git-identity.js";
import { droppedRef } from "../../git/agent-refs.js";
import { mainLineUnder, presenceOf } from "./agent-changes.js";
import { commitWorktreeRemainder } from "../../git/remote/root-repo.js";
import type { Upstream } from "./land-target.js";
import type { AgentWorktrees } from "../worktrees/worktrees.js";
import { assertLinked } from "../worktrees/checkout-link.js";

// Rebases a conversation's branch onto main's HEAD before each turn and again before land; a refused rebase retries
// with `--onto main landedTip`, replaying only commits main does not already hold. Touches only this conversation's own
// worktree, never the main checkout; no repo lock is taken. A spawned child cut from its parent's checkout follows that
// checkout instead (land-target.ts `upstreamOf`): what the parent has written is committed there first, as a checkpoint
// is, and only the child's own commits are replayed onto it.
//
// LETTING COMMITS GO IS ONE DECISION, MADE ON CONTENT (2026-10-20). Replaying only what follows a land's tip drops every
// commit up to it, so both lines take it through one door, `replaySinceLanded`, and only once the tree the work landed
// in is read to still hold what the dropped commits carry (`upstreamAccountsForPrefix`): the rung records that a land
// happened, never that it is still there. Until then the parent's line trusted the rung outright, and a parent `merge`
// that wrote nothing yet moved it (land.ts, now proven) had its child's next catch-up rebase every commit away. The tip
// before a drop is pinned on `refs/intentic/dropped/<id>` (agent-refs.ts `droppedRef`) whatever the rebase then does.
//
// `standsElsewhere`: a repo whose copy the conversation moved to a branch of its own (a pull request it was asked to
// work on, a CI branch it pushes) is not synced at all. A rebase runs on whatever the copy stands on, so it used to
// rewrite that branch onto the owner's HEAD, unpushed commits included, and commit the dirty remainder onto it, while
// `agent/<id>`, the branch land reads, never moved. What the turn commits there reaches `agent/<id>` by the turn's carry
// instead (conversations/worktrees/stray-work.ts), and a land measures it from there as from any branch.

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

// The newest commit both share, or "" for unrelated histories.
const mergeBaseOf = async (dir: string, a: string, b: string, git: GitRunner): Promise<string> => {
    try {
        return (await git(dir, ["merge-base", a, b])).stdout.trim();
        // allow(silent-catch): merge-base exits non-zero only when the histories share no commit, which is the answer.
    } catch {
        return "";
    }
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

// Whether the tree the work lands in can still account for every path the prefix about to be dropped carries. `landedTip`
// is bookkeeping, not evidence: a land copies content into that tree and records the rung, and the user can then discard
// all of it in the Changes panel without a single sha moving. A path is accounted for when the tree still reads the same
// on it (the land is committed, or landed and not yet committed), or when the upstream's own history has moved it since
// the fork and the path is still there, which is the user editing what they landed. A path the upstream moved AWAY (a
// rename, a deletion) is not that: the land never reached it, and its commit is the only copy of the work. One path
// unaccounted for means the land is not there any more: the rung is void and the prefix must not be dropped.
const upstreamAccountsForPrefix = async (
    worktree: string,
    // The checkout the work lands in: the main tree's, or the parent's for a child following it.
    upstream: string,
    onto: string,
    landedTip: string,
    // Upstream movement since divergence, already read for the report.
    moved: readonly string[],
    git: GitRunner,
): Promise<boolean> => {
    try {
        // Three-dot: the prefix's own side of the fork, so main-line movement is not mistaken for landed work.
        const prefix = await pathsOf(worktree, [`${onto}...${landedTip}`], git);
        if (prefix.length === 0) {
            return true;
        }
        const { inWorkspace } = await presenceOf(upstream, worktree, landedTip, prefix, git);
        const edited = new Set(moved);
        for (const path of prefix) {
            if (!inWorkspace.has(path) && !(edited.has(path) && (await pathExists(join(upstream, path))))) {
                return false;
            }
        }
        return true;
    } catch {
        // A probe that could not run has proven nothing; refusing costs a conflict errand, dropping costs the work.
        return false;
    }
};

// The one road by which a catch-up lets commits go: everything up to `landedTip` dropped and only what follows replayed,
// taken only while HEAD still descends from `landedTip` and the upstream still accounts for what it drops. The tip as it
// stood is pinned first. `undefined` when the drop is not proven safe and nothing was tried; else whether it replayed.
const replaySinceLanded = async (
    worktree: string,
    upstream: string,
    onto: string,
    landedTip: string | undefined,
    moved: readonly string[],
    id: string,
    git: GitRunner,
): Promise<boolean | undefined> => {
    if (landedTip === undefined || !(await contains(worktree, "HEAD", landedTip, git))) {
        return undefined;
    }
    if (!(await upstreamAccountsForPrefix(worktree, upstream, onto, landedTip, moved, git))) {
        return undefined;
    }
    const tip = (await git(worktree, ["rev-parse", "HEAD"])).stdout.trim();
    await git(worktree, ["update-ref", droppedRef(id), tip]);
    return (await rebaseSince(worktree, onto, landedTip, AGENT_GIT_AUTHOR, git)).ok;
};

const syncOne = async (
    worktrees: AgentWorktrees,
    id: string,
    repo: string,
    // Main-line commit the branch was cut from or last synced onto.
    base: string | undefined,
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
    if (!(await worktrees.attached(id, repo))) {
        return undefined; // Standing on a branch of its own: see `standsElsewhere`.
    }
    const head = await headSha(worktrees.mainDir(repo), git);
    if (head === undefined) {
        return undefined; // Unborn HEAD, or the main checkout is gone: no main line to sit on.
    }
    const tip = (await git(worktree, ["rev-parse", "HEAD"])).stdout.trim();
    if (tip === head || (await contains(worktree, tip, head, git))) {
        return undefined;
    }
    // Main rewritten behind `base` (mainLineUnder): the commits between the merge-base and `base` are ones main dropped,
    // not this branch's work, so only what follows `base` is replayed and counted as the branch's own. A plain rebase
    // would carry every dropped commit back into the branch, and from there into the owner's tree at the next land.
    const merged = await mergeBaseOf(worktree, tip, head, git);
    const floor = base === undefined || merged === "" ? merged : await mainLineUnder(worktree, merged, base, tip, git);
    const since = floor === merged ? undefined : floor;
    // Main-line movement since divergence (three-dot), or since `base` when main was rewritten; read before the rebase moves `tip`.
    const moved = await pathsOf(worktree, since === undefined ? [`${tip}...${head}`] : [since, head], git);
    const mine = new Set(await pathsOf(worktree, since === undefined ? [`${head}...${tip}`] : [since, tip], git));
    const overlap = moved.filter((path) => mine.has(path));
    const commits = Number((await git(worktree, ["rev-list", "--count", `${tip}..${head}`])).stdout.trim());
    const behind = { repo, onto: head, commits, moved, overlap };
    // Commits the dirty remainder first; `git rebase` refuses to start on a dirty tree.
    await commitWorktreeRemainder(repo, worktree, withConversationTrailer(`Agent: ${title ?? id}`, id), worktrees.mainDir("root"), git);
    const rebased = since === undefined ? await rebaseOnto(worktree, head, AGENT_GIT_AUTHOR, git) : await rebaseSince(worktree, head, since, AGENT_GIT_AUTHOR, git);
    if (rebased.ok) {
        return behind;
    }
    // Refused; retry without the already-landed prefix, the likely cause of the conflict.
    const replayed = await replaySinceLanded(worktree, worktrees.mainDir(repo), head, landedTip, moved, id, git);
    return replayed === true ? behind : { ...behind, blocked: true };
};

// A child's repo onto its parent's checkout: the parent's remainder committed first, so the child sits on everything the
// parent has written, then only the child's own commits replayed: from its last land's tip where the parent is read to
// still hold what that drops (`replaySinceLanded`), else from the parent commit it sat on, every commit of it. A refusal
// rolls back and leaves the branch where it was, as the main line's does.
const syncOntoParent = async (
    worktrees: AgentWorktrees,
    id: string,
    parent: string,
    composed: SyncedRepo,
    title: string | undefined,
    git: GitRunner,
): Promise<RepoSync | undefined> => {
    const { repo, base, landedTip } = composed;
    const worktree = worktrees.worktreeDir(id, repo);
    const upstream = worktrees.worktreeDir(parent, repo);
    if (base === undefined || !(await pathExists(join(worktree, ".git"))) || !(await pathExists(join(upstream, ".git")))) {
        return undefined;
    }
    if (!(await worktrees.attached(id, repo))) {
        return undefined; // Standing on a branch of its own: see `standsElsewhere`.
    }
    // The remainder is the parent's own work on the parent's branch, so the trailer names the parent, not the child.
    await commitWorktreeRemainder(repo, upstream, withConversationTrailer(`Agent: before ${title ?? id} caught up`, parent), worktrees.mainDir("root"), git);
    const head = await headSha(upstream, git);
    if (head === undefined) {
        return undefined;
    }
    const tip = (await git(worktree, ["rev-parse", "HEAD"])).stdout.trim();
    if (tip === head || (await contains(worktree, tip, head, git))) {
        return undefined;
    }
    const moved = await pathsOf(worktree, [`${tip}...${head}`], git);
    const mine = new Set(await pathsOf(worktree, [`${head}...${tip}`], git));
    const commits = Number((await git(worktree, ["rev-list", "--count", `${tip}..${head}`])).stdout.trim());
    const behind = { repo, onto: head, commits, moved, overlap: moved.filter((path) => mine.has(path)) };
    await commitWorktreeRemainder(repo, worktree, withConversationTrailer(`Agent: ${title ?? id}`, id), worktrees.mainDir("root"), git);
    const sinceLanded = await replaySinceLanded(worktree, upstream, head, landedTip, moved, id, git);
    const replayed = sinceLanded ?? (await rebaseSince(worktree, head, base, AGENT_GIT_AUTHOR, git)).ok;
    return replayed ? behind : { ...behind, blocked: true };
};

// One repo of a composition as a sync reads it: the land rung (`landedTip`) the main line's retry needs, and the commit
// a child cut from its parent sits on (`base`).
interface SyncedRepo {
    readonly repo: string;
    readonly base?: string | undefined;
    readonly landedTip?: string | undefined;
}

const MAIN_LINE: Upstream = { kind: "main" };

// Syncs every repo of a conversation's composition; returns only repos that were behind, empty when all already sit on
// their upstream's tip. Runs concurrently across repos: separate git dirs and branches, no shared state.
export const syncConversation = async (
    worktrees: AgentWorktrees,
    id: string,
    repos: readonly SyncedRepo[],
    title: string | undefined,
    upstream: Upstream = MAIN_LINE,
    git: GitRunner = defaultGit,
): Promise<RepoSync[]> => {
    if (upstream.kind === "none") {
        return [];
    }
    // A checkout that stopped sharing main's objects would make every range below a raw `bad object`.
    await assertLinked(worktrees, id, repos);
    const results = await Promise.all(
        repos.map((composed) =>
            upstream.kind === "parent"
                ? syncOntoParent(worktrees, id, upstream.parent, composed, title, git)
                : syncOne(worktrees, id, composed.repo, composed.base, composed.landedTip, title, git),
        ),
    );
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
    upstream: Upstream = MAIN_LINE,
    git: GitRunner = defaultGit,
): Promise<readonly Repo[]> => {
    const synced = await syncConversation(
        worktrees,
        entry.id,
        entry.repos.map(({ repo, base, landedTip }) => ({ repo, base, landedTip })),
        entry.title,
        upstream,
        git,
    );
    const onto = new Map(synced.filter((repo) => repo.blocked !== true).map((repo) => [repo.repo, repo.onto]));
    if (onto.size === 0) {
        return entry.repos;
    }
    // a fresh record per repo is the point: these are the registry's own persisted rows
    const moved = entry.repos.map((composed): Repo => ({ ...composed, base: onto.get(composed.repo) ?? composed.base }));
    await recordWorktree(entry.id, moved);
    return moved;
};
