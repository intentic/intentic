import type { GitRunner } from "@intentic/scaffold";

/* WHERE A CONVERSATION'S COMMITS LIVE — on `refs/heads/` while it is on the board, on a shelf once it is not.
 *
 * Archiving reclaims a conversation's CHECKOUT and keeps its branch, because the branch is the archive
 * (agents/archive.ts). What it also kept was a full `refs/heads/` entry per repo, for every conversation that
 * ever ran — the workspace this was written against carried 158 agent branches against 26 live checkouts, and
 * 132 of them belonged to agents nobody was going to open again. That is not free: a ref is a file until
 * something packs it, `refs/heads/` is what the branch picker lists and what a push has to walk, and the count
 * only ever goes up. It is also the one cost of archiving that the user cannot see and cannot act on.
 *
 * So the branch moves off `refs/heads/` onto a shelf — `refs/agent/<id>` rather than `refs/heads/agent/<id>`.
 * No commit moves, nothing is repacked, nothing is at risk: it is two ref writes per repo, and the inverse is
 * two more.
 *
 * WHY THAT EXACT PATH, rather than a tidier `refs/archived/...`: git resolves a bare name against `refs/<name>`
 * BEFORE `refs/heads/<name>` (gitrevisions), so `agent/<id>` — the string every caller already holds as
 * `entry.branch` — keeps naming the same commit whether the conversation is live or parked. Landing an
 * archived agent, the review's base→tip diff, `merge-base` for a standing, `show <branch>:<path>` for a file's
 * before-side: all of it keeps working with no live-or-parked branch anywhere in the caller. The only code that
 * has to know is the code that says `refs/heads/` out loud — branchSha below, and the checkout re-attach in
 * worktrees.ts — which is exactly the code that should.
 *
 * Parking has to be as cheap to UNDO as to do, because a user resuming an archived conversation must not be
 * able to tell: `ensure` unparks the branch and re-attaches the checkout in the same pass, before the turn that
 * triggered it runs a single tool.
 */

// Ref namespaces, spelled once. The shelf is the branch's own name one directory up from `refs/heads/`.
const HEADS = "refs/heads/";
const AGENT = "agent/";
const parkedRef = (branch: string): string => `refs/${branch}`;

/* The tip of an agent's branch as the MAIN repo sees it — the stand-in for `rev-parse HEAD` whenever the
 * checkout is retired (the refs and the objects live in the shared git dir either way). Undefined when neither
 * spelling exists, which reads as "nothing of this agent's is in this repo any more".
 *
 * Both spellings in ONE for-each-ref, rather than resolving the bare name: a rev-spec would answer correctly
 * but it answers through the ambiguity rules, and the one moment both spellings exist — a crash between
 * parkAgentRefs' two writes — is the moment we want a plain answer rather than a warning on stderr. A pattern
 * that matches nothing is an empty line, not an error, so this needs no try/catch either. */
export const branchSha = async (main: string, branch: string, git: GitRunner): Promise<string | undefined> => {
    const { stdout } = await git(main, ["for-each-ref", "--format=%(objectname)", `${HEADS}${branch}`, parkedRef(branch)]);
    return stdout.split("\n").find((line) => line !== "");
};

/* Park every branch in this repo belonging to an agent that is off the board — one agent when a retire calls
 * it, the whole archive when the boot sweep does. Returns the ids it parked.
 *
 * ONE for-each-ref asks "which of them are still branches here", so the steady state (a boot with nothing left
 * to park, a retire for a repo the agent never touched) costs a single spawn and no writes. That is what lets
 * the boot sweep run this unconditionally on every repo, every time.
 *
 * The shelf ref is written BEFORE the branch is deleted, and rolled back if the delete fails. A crash between
 * the two leaves both spellings on the same commit — a "refname is ambiguous" warning and nothing worse, which
 * the next pass converges. The other order would put the commit one gc away from being gone. */
export const parkAgentRefs = async (main: string, ids: ReadonlySet<string>, git: GitRunner): Promise<string[]> => {
    const { stdout } = await git(main, ["for-each-ref", "--format=%(objectname) %(refname)", `${HEADS}${AGENT}`]);
    const parked: string[] = [];
    for (const line of stdout.split("\n")) {
        const [sha, ref] = line.split(" ");
        if (sha === undefined || ref === undefined) {
            continue;
        }
        const branch = ref.slice(HEADS.length);
        if (!ids.has(branch.slice(AGENT.length))) {
            continue;
        }
        await git(main, ["update-ref", parkedRef(branch), sha]);
        try {
            // Refuses on a branch some worktree still has checked out — the one case where parking would be
            // wrong, and git is the authority on it rather than anything this module could test for.
            await git(main, ["branch", "-D", branch]);
            parked.push(branch.slice(AGENT.length));
        } catch {
            await git(main, ["update-ref", "-d", parkedRef(branch)]).catch(() => undefined);
        }
    }
    return parked;
};

// Put a parked branch back on `refs/heads/` — the first half of restoring an archived conversation, and a
// no-op (one spawn) for a branch that never left. `git worktree add` is why this must run: handed a name that
// resolves only through the shelf, it checks the commit out DETACHED, and the turn's commits would then land
// on nothing.
export const unparkAgentRef = async (main: string, branch: string, git: GitRunner): Promise<void> => {
    const { stdout } = await git(main, ["for-each-ref", "--format=%(objectname)", parkedRef(branch)]);
    const sha = stdout.trim();
    if (sha === "") {
        return;
    }
    await git(main, ["update-ref", `${HEADS}${branch}`, sha]);
    await git(main, ["update-ref", "-d", parkedRef(branch)]);
};

// Drop an agent's commits from this repo for good — `discard` and the archive's purge, the two places the user
// is told the work goes away. Both spellings, because the caller does not know which one holds it and asking
// would cost more than the delete that misses.
export const dropAgentRef = async (main: string, branch: string, git: GitRunner): Promise<void> => {
    await git(main, ["branch", "-D", branch]).catch(() => undefined);
    await git(main, ["update-ref", "-d", parkedRef(branch)]).catch(() => undefined);
};

// The shelf's own orphan sweep, alongside the one for conversation dirs: a parked ref whose registry entry is
// gone is holding commits nothing can ever reach again. Returns how many it dropped.
export const dropOrphanParkedRefs = async (main: string, known: ReadonlySet<string>, git: GitRunner): Promise<number> => {
    const { stdout } = await git(main, ["for-each-ref", "--format=%(refname)", parkedRef(AGENT)]);
    let dropped = 0;
    for (const ref of stdout.split("\n")) {
        if (ref === "" || known.has(ref.slice(parkedRef(AGENT).length))) {
            continue;
        }
        await git(main, ["update-ref", "-d", ref]).catch(() => undefined);
        dropped += 1;
    }
    return dropped;
};
