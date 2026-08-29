import { access } from "node:fs/promises";
import { join } from "node:path";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { headSha, rebaseOnto, rebaseSince } from "../git/changes.js";
import { AGENT_GIT_AUTHOR } from "../git/git.js";
import { commitWorktreeRemainder } from "../git/root-repo.js";
import type { AgentWorktrees } from "./worktrees.js";

/* BRING A CONVERSATION'S BRANCH ONTO THE CURRENT MAIN LINE, before its next turn reads a line of it.
 *
 * A worktree's base is frozen at the moment it is created (worktrees.ts), and a conversation can sit for hours
 * between turns, parked on a question, waiting on an approval, or simply not the one the user is looking at.
 * Meanwhile the main line moves: the user commits, other agents land and are committed. Nothing used to
 * reconcile the two, so the resumed turn read code that no longer exists, wrote a delta against a dead base,
 * and the auto-land at the end refused with `diverged`. Recovery cost a WHOLE EXTRA TURN, the conflict report,
 * the user's click, and a model re-resolving conflicts it would never have had if it had started from today's
 * main (agents/land.ts, web conflictResolution.ts).
 *
 * So the reconciliation moves to the front, where it is cheap: rebase the branch onto main's HEAD before the
 * turn starts. The same operation the conflict errand asks the agent to perform, run by the daemon for free
 * instead of by a model for the price of a turn.
 *
 * WHY THIS IS SAFE TO DO WITHOUT ASKING, three properties, and dropping any one of them would make it a
 * decision the user has to be in the room for:
 *
 *   · IT ABORTS. Both attempts below are runOrAbort (git/changes.ts): a rebase that hits a conflict is rolled
 *     back and the worktree is byte-identical again, which is also what makes it safe to stack the second one
 *     on the first. A branch that cannot be moved cleanly simply is not moved, and the turn runs exactly as it
 *     does today, the existing land-time conflict flow is still there behind it. Deliberately NOT resolved
 *     here: the user asked a question, and hijacking their turn to fix a merge is worse than the conflict.
 *   · IT LOSES NOTHING. A worktree is dirty between turns whenever the last one errored or was interrupted, and
 *     git refuses to rebase a dirty tree. The remainder is committed onto the branch first, the same
 *     provenance commit, with the same author, that land takes at the end of every turn.
 *   · IT STAYS ON THE BRANCH. Nothing here touches the main checkout: main's HEAD is READ, and every write
 *     lands in this conversation's own worktree and its own refs/heads/agent/<id>.
 *
 * WHAT IS REPLAYED IS ONLY WHAT MAIN HAS NOT ALREADY GOT, and getting that wrong is what made the rebase
 * refuse on work that could not possibly conflict. The plain `git rebase` replays every commit the branch has
 * that main lacks by ANCESTRY, and a landed conversation's commits are exactly that: land copies content into
 * the main tree as an uncommitted patch, so when the user commits it, their commit carries the branch's
 * content under a sha of its own and ancestry still calls the branch's originals unmerged. Replaying them onto
 * a main line that already holds the result is where the conflicts came from, in two shapes:
 *
 *   · SLICING. Two turns land, C1 then C2, both editing the same lines; the user commits the main tree once,
 *     so main holds the NET of the two. Replaying C1 alone then puts main's C1+C2 result against C1's
 *     intermediate one over the same region, and git has no way to call that anything but a conflict.
 *   · DRIFT. Main goes on to rewrite the file the landed work sits in. Even one commit then replays against
 *     text that has moved, though its own content is already in.
 *
 * Both are the same mistake, and the registry already knows the rung that avoids it: `landedTip`, the commit
 * whose content land handed to the main tree. Everything at or before it is in main by definition, which is
 * the premise anchorOf and the turn's own span are built on (agents/agent-changes.ts, agent/agent.routes.ts).
 * So a refused rebase is retried as `--onto <main> <landedTip>`: DROP the delivered prefix, replay only what
 * the branch has taken since. On the common shape, a conversation whose whole branch has landed, that replays
 * nothing and simply moves the branch to main's tip, which cannot fail.
 *
 * SECOND, not first, and that ordering is the safety property. Dropping the prefix is only sound while main
 * really holds the content, and the case where it does not, a land the user discarded or never committed, is
 * precisely the case where nothing in main collides with those commits and the plain rebase goes through. A
 * refusal is the evidence. Where the conflict is in UNLANDED work instead, the retry hits the same wall and
 * the repo reports `blocked` exactly as before.
 *
 * The one thing it cannot promise is that the result still WORKS: a rebase that applies cleanly line-by-line
 * can still leave the agent calling something main just renamed. The HUMAN is told (the `worktree` frame) and
 * the AGENT is not, telling it only ever bought a verification sweep that came back green, and the case the
 * warning was written for is caught by the land at the end of the turn instead (agent/turn-preamble.ts has the
 * whole argument). Announce, don't ask: at the moment the user is answering their agent's question they have
 * nothing to decide this with, and the alternative to rebasing is not "stay safe", it is "conflict later",
 * which interrupts them harder.
 *
 * NO REPO LOCK, on purpose, the same call worktrees.ts's linkComposition makes and for the same reason. The
 * lock guards a repo's shared worktree ADMIN area and the main index; this reads main's HEAD (a ref) and writes
 * only inside one conversation's own checkout, where its private index and HEAD already make concurrent agent
 * work safe. Taking it would serialize the whole fleet's turn starts behind one queue.
 */

// One repo of the composition whose branch is not sitting on main's tip. The counts describe the main-line
// commits BETWEEN the two, gained when the rebase went through, still missing when `blocked` says it did not.
export interface RepoSync {
    readonly repo: string;
    // The main-line sha involved: where the branch now sits, or where it failed to reach.
    readonly onto: string;
    readonly commits: number;
    // What those commits touched...
    readonly moved: readonly string[];
    // ...intersected with what this agent has changed. The actionable half: a main line that moved 200 files
    // is noise, the two of them the agent also edited is the instruction to go and re-check something.
    readonly overlap: readonly string[];
    // The rebase would not apply and was rolled back, the branch still sits on its old base.
    readonly blocked?: true;
}

const exists = async (path: string): Promise<boolean> => {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
};

/* Every path a span touches, `--no-renames` because the two lists below are INTERSECTED, and a rename that
 * collapses to its destination cannot intersect anything on the source side.
 *
 * Concretely: main renames a file the agent is editing. `moved` names the destination, `mine` names the
 * source, `overlap` comes back empty, and the turn preamble tells the agent main moved underneath it while
 * naming nothing, on the one file whose work is about to be replayed onto a path that no longer exists.
 * Detection has to be disabled EXPLICITLY: git has defaulted diff.renames to true since 2.9, so leaving `-M`
 * off does not leave detection off. (agents/origins.ts carried the same defect on the attribution side.) */
const pathsOf = async (dir: string, args: readonly string[], git: GitRunner): Promise<string[]> => {
    const { stdout } = await git(dir, ["diff", "--name-only", "--no-renames", "-z", ...args]);
    return stdout.split("\0").filter((path) => path !== "");
};

// Does `tip` already contain `head`? One spawn, and it is the answer on every turn where nobody committed
// since the last one, which is most of them, so the whole pass costs a single `merge-base` per repo.
const contains = async (dir: string, tip: string, head: string, git: GitRunner): Promise<boolean> => {
    try {
        await git(dir, ["merge-base", "--is-ancestor", head, tip]);
        return true;
    } catch {
        return false;
    }
};

/* THE RETRY, and the two conditions it will not move a branch without.
 *
 * `landedTip` has to still be an ancestor of the branch: a rewrite that orphaned it (a `merge main` the agent
 * ran itself, an earlier retry) leaves a sha that names no rung of this history, and `--onto` past it would
 * replay the wrong span. Read off HEAD rather than the caller's `tip`, because the provenance commit above may
 * have moved it, and that commit is unlanded work the retry must keep.
 *
 * Absent, the conversation has never landed, so there is no delivered prefix to drop and the refusal stands:
 * every commit on the branch is genuinely outstanding work. */
const replayUnlanded = async (worktree: string, onto: string, landedTip: string | undefined, git: GitRunner): Promise<boolean> => {
    if (landedTip === undefined || !(await contains(worktree, "HEAD", landedTip, git))) {
        return false;
    }
    return (await rebaseSince(worktree, onto, landedTip, AGENT_GIT_AUTHOR, git)).ok;
};

const syncOne = async (
    worktrees: AgentWorktrees,
    id: string,
    repo: string,
    // Where this repo's work last reached the main tree, the registry's own land bookkeeping. See replayUnlanded.
    landedTip: string | undefined,
    title: string | undefined,
    git: GitRunner,
): Promise<RepoSync | undefined> => {
    const worktree = worktrees.worktreeDir(id, repo);
    // A retired checkout (an archived agent whose ensure has not re-attached it yet) has no index to rebase in.
    // Nothing is lost by skipping: the branch is untouched and the next attached turn syncs it.
    if (!(await exists(join(worktree, ".git")))) {
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
    // Three-dot: what HEAD has since the two diverged, which is exactly the main-line movement the agent has
    // been working underneath. Read BEFORE the rebase, while `tip` still names the branch's old position.
    const moved = await pathsOf(worktree, [`${tip}...${head}`], git);
    const mine = new Set(await pathsOf(worktree, [`${head}...${tip}`], git));
    const overlap = moved.filter((path) => mine.has(path));
    const commits = Number((await git(worktree, ["rev-list", "--count", `${tip}..${head}`])).stdout.trim());
    const behind = { repo, onto: head, commits, moved, overlap };
    // The dirty remainder becomes a commit before anything moves, `git rebase` refuses to start otherwise, and
    // this is the commit land would have taken anyway. Only on the path that is about to rebase, so an ordinary
    // turn on an up-to-date branch never grows a commit it did not ask for.
    await commitWorktreeRemainder(repo, worktree, `Agent: ${title ?? id}`, git);
    if ((await rebaseOnto(worktree, head, AGENT_GIT_AUTHOR, git)).ok) {
        return behind;
    }
    // Refused. Everything the branch has already DELIVERED to the main tree is what it is most likely to have
    // refused over, so try again without it (see the header, and replayUnlanded).
    return (await replayUnlanded(worktree, head, landedTip, git)) ? behind : { ...behind, blocked: true };
};

/* Sync every repo of a conversation's composition. Returns only the repos that were BEHIND, an empty array is
 * the ordinary answer and means the branch already sits on main's tip.
 *
 * Concurrent across repos: each one is a different git dir and a different branch, and nothing here reaches the
 * shared state that would make them contend. */
export const syncConversation = async (
    worktrees: AgentWorktrees,
    id: string,
    // The composition, each repo carrying the land rung the retry needs (agent/agent.routes.ts reads it off the
    // registry entry: the worktree record holds only the base).
    repos: readonly { readonly repo: string; readonly landedTip?: string | undefined }[],
    title: string | undefined,
    git: GitRunner = defaultGit,
): Promise<RepoSync[]> => {
    const results = await Promise.all(repos.map(({ repo, landedTip }) => syncOne(worktrees, id, repo, landedTip, title, git)));
    return results.filter((result) => result !== undefined);
};

/* THE SAME SYNC, IMMEDIATELY BEFORE A LAND, and the answer to why a sandbox that already rebases at every
 * turn start still met the conflict errand several times a day.
 *
 * Turn-start is the right moment for the MODEL (it reads today's code) and the wrong one for the LAND. The two
 * are separated by the whole turn: half an hour and a few hundred tool calls, during which the user lands
 * other agents and commits them. A land is `git apply --check` against main's working tree, so every
 * main-line commit that arrived inside that window is a fresh chance to refuse over lines this agent never
 * touched. The wider the fleet, the wider the window, which is why the errand clustered on exactly the days
 * with the most parallel work.
 *
 * So the branch is brought forward once more, at the last moment before its patch is measured. Every safety
 * property of the turn-start sync holds unchanged and for the same reasons (see the header): it aborts, it
 * commits the remainder first so nothing is lost, and it writes only inside this conversation's own worktree.
 * A blocked repo simply lands from where it was, which is today's behaviour in full.
 *
 * `recordWorktree` is injected rather than imported: this module knows git and worktrees, and the registry is
 * the caller's. Returns the composition to LAND FROM, with `base` moved to the main-line sha each rebased repo
 * now sits on. Landing from the pre-sync composition would hand anchorOf a base the rebase has just orphaned,
 * and standing.ts reads `tip !== base` as "this agent produced something". */
// The shape this needs off a composition row, spelled structurally so the sync layer takes no dependency on
// the registry's store types. The generic keeps every other field the caller's rows carry (landedHead,
// landedAt) intact through the rewrite below.
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
