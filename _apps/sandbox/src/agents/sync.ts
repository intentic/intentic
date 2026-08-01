import { access } from "node:fs/promises";
import { join } from "node:path";
import { defaultGit, gitCommitAll, type GitRunner } from "@intentic/scaffold";
import { headSha, rebaseOnto } from "../git/changes.js";
import { AGENT_GIT_AUTHOR } from "../git/git.js";
import type { AgentWorktrees } from "./worktrees.js";

/* BRING A CONVERSATION'S BRANCH ONTO THE CURRENT MAIN LINE, before its next turn reads a line of it.
 *
 * A worktree's base is frozen at the moment it is created (worktrees.ts), and a conversation can sit for hours
 * between turns — parked on a question, waiting on an approval, or simply not the one the user is looking at.
 * Meanwhile the main line moves: the user commits, other agents land and are committed. Nothing used to
 * reconcile the two, so the resumed turn read code that no longer exists, wrote a delta against a dead base,
 * and the auto-land at the end refused with `diverged`. Recovery cost a WHOLE EXTRA TURN — the conflict report,
 * the user's click, and a model re-resolving conflicts it would never have had if it had started from today's
 * main (agents/land.ts, web conflictResolution.ts).
 *
 * So the reconciliation moves to the front, where it is cheap: rebase the branch onto main's HEAD before the
 * turn starts. The same operation the conflict errand asks the agent to perform, run by the daemon for free
 * instead of by a model for the price of a turn.
 *
 * WHY THIS IS SAFE TO DO WITHOUT ASKING — three properties, and dropping any one of them would make it a
 * decision the user has to be in the room for:
 *
 *   · IT ABORTS. `rebaseOnto` is runOrAbort (git/changes.ts): a rebase that hits a conflict is rolled back and
 *     the worktree is byte-identical again. A branch that cannot be moved cleanly simply is not moved, and the
 *     turn runs exactly as it does today — the existing land-time conflict flow is still there behind it.
 *     Deliberately NOT resolved here: the user asked a question, and hijacking their turn to fix a merge is
 *     worse than the conflict.
 *   · IT LOSES NOTHING. A worktree is dirty between turns whenever the last one errored or was interrupted, and
 *     git refuses to rebase a dirty tree. The remainder is committed onto the branch first — the same
 *     provenance commit, with the same author, that land takes at the end of every turn.
 *   · IT STAYS ON THE BRANCH. Nothing here touches the main checkout: main's HEAD is READ, and every write
 *     lands in this conversation's own worktree and its own refs/heads/agent/<id>.
 *
 * The one thing it cannot promise is that the result still WORKS: a rebase that applies cleanly line-by-line
 * can still leave the agent calling something main just renamed. That is why the outcome is reported rather
 * than swallowed — the turn tells the agent what moved under it (agent/turn-preamble.ts) and the transcript
 * tells the human (the `worktree` frame). Announce, don't ask: at the moment the user is answering their
 * agent's question they have nothing to decide this with, and the alternative to rebasing is not "stay safe",
 * it is "conflict later", which interrupts them harder.
 *
 * NO REPO LOCK, on purpose — the same call worktrees.ts's linkComposition makes and for the same reason. The
 * lock guards a repo's shared worktree ADMIN area and the main index; this reads main's HEAD (a ref) and writes
 * only inside one conversation's own checkout, where its private index and HEAD already make concurrent agent
 * work safe. Taking it would serialize the whole fleet's turn starts behind one queue.
 */

// One repo of the composition whose branch is not sitting on main's tip. The counts describe the main-line
// commits BETWEEN the two — gained when the rebase went through, still missing when `blocked` says it did not.
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
    // The rebase would not apply and was rolled back — the branch still sits on its old base.
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

/* Every path a span touches — `--no-renames` because the two lists below are INTERSECTED, and a rename that
 * collapses to its destination cannot intersect anything on the source side.
 *
 * Concretely: main renames a file the agent is editing. `moved` names the destination, `mine` names the
 * source, `overlap` comes back empty, and the turn preamble tells the agent main moved underneath it while
 * naming nothing — on the one file whose work is about to be replayed onto a path that no longer exists.
 * Detection has to be disabled EXPLICITLY: git has defaulted diff.renames to true since 2.9, so leaving `-M`
 * off does not leave detection off. (agents/origins.ts carried the same defect on the attribution side.) */
const pathsOf = async (dir: string, args: readonly string[], git: GitRunner): Promise<string[]> => {
    const { stdout } = await git(dir, ["diff", "--name-only", "--no-renames", "-z", ...args]);
    return stdout.split("\0").filter((path) => path !== "");
};

// Does `tip` already contain `head`? One spawn, and it is the answer on every turn where nobody committed
// since the last one — which is most of them, so the whole pass costs a single `merge-base` per repo.
const contains = async (dir: string, tip: string, head: string, git: GitRunner): Promise<boolean> => {
    try {
        await git(dir, ["merge-base", "--is-ancestor", head, tip]);
        return true;
    } catch {
        return false;
    }
};

const syncOne = async (
    worktrees: AgentWorktrees,
    id: string,
    repo: string,
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
        return undefined; // Unborn HEAD, or the main checkout is gone — no main line to sit on.
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
    // The dirty remainder becomes a commit before anything moves — `git rebase` refuses to start otherwise, and
    // this is the commit land would have taken anyway. Only on the path that is about to rebase, so an ordinary
    // turn on an up-to-date branch never grows a commit it did not ask for.
    await gitCommitAll(worktree, `Agent: ${title ?? id}`, AGENT_GIT_AUTHOR, git);
    const rebased = await rebaseOnto(worktree, head, AGENT_GIT_AUTHOR, git);
    return rebased.ok ? behind : { ...behind, blocked: true };
};

/* Sync every repo of a conversation's composition. Returns only the repos that were BEHIND — an empty array is
 * the ordinary answer and means the branch already sits on main's tip.
 *
 * Concurrent across repos: each one is a different git dir and a different branch, and nothing here reaches the
 * shared state that would make them contend. */
export const syncConversation = async (
    worktrees: AgentWorktrees,
    id: string,
    repos: readonly { readonly repo: string }[],
    title: string | undefined,
    git: GitRunner = defaultGit,
): Promise<RepoSync[]> => {
    const results = await Promise.all(repos.map(({ repo }) => syncOne(worktrees, id, repo, title, git)));
    return results.filter((result) => result !== undefined);
};
