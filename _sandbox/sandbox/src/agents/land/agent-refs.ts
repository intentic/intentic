import type { GitRunner } from "@intentic/scaffold";

// Archived agents keep their branch but move it off `refs/heads/` onto a shelf, `refs/agent/<id>`, since git resolves a
// bare name against `refs/<name>` before `refs/heads/<name>`, so `entry.branch` keeps naming the same commit whether
// live or parked.

// Ref namespace strings; the shelf is the branch's own path one level up from `refs/heads/`.
const REFS = "refs/";
const HEADS = `${REFS}heads/`;
const AGENT = "agent/";
const parkedRef = (branch: string): string => `${REFS}${branch}`;

// Tip of an agent's branch as the main repo sees it, live or parked; undefined means nothing of this agent's remains.
// Reads both ref spellings in one for-each-ref, since a crash mid-parkAgentRefs can briefly leave both existing.
export const branchSha = async (main: string, branch: string, git: GitRunner): Promise<string | undefined> => {
    const { stdout } = await git(main, ["for-each-ref", "--format=%(objectname)", `${HEADS}${branch}`, parkedRef(branch)]);
    return stdout.split("\n").find((line) => line !== "");
};

// All agent branch tips in this repo in one spawn, keyed by branch name; the parked spelling wins on a collision, and
// an unreadable repo returns empty rather than throwing.
export const agentBranchTips = async (main: string, git: GitRunner): Promise<Map<string, string>> => {
    const { stdout } = await git(main, ["for-each-ref", "--format=%(objectname) %(refname)", `${HEADS}${AGENT}`, parkedRef(AGENT)]).catch(() => ({
        stdout: "",
    }));
    const tips = new Map<string, string>();
    for (const line of stdout.split("\n")) {
        const [sha, ref] = line.split(" ");
        if (sha === undefined || ref === undefined) {
            continue;
        }
        const branch = ref.startsWith(HEADS) ? ref.slice(HEADS.length) : ref.slice(REFS.length);
        if (!tips.has(branch)) {
            tips.set(branch, sha);
        }
    }
    return tips;
};

// Name of the branch the user's checkout is on, for rebasing an agent onto it.
// Undefined on a detached HEAD rather than the literal string "HEAD", which is not a branch to rebase onto.
export const mainBranchOf = async (main: string, git: GitRunner): Promise<string | undefined> => {
    const { stdout } = await git(main, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const branch = stdout.trim();
    return branch === "" || branch === "HEAD" ? undefined : branch;
};

// Parks every branch here belonging to an agent off the board; returns the ids parked. The shelf ref is written before
// the branch is deleted and rolled back on failure, so a crash cannot lose the commit.
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
            // Fails if a worktree still has this branch checked out; git is the authority here, not this module.
            await git(main, ["branch", "-D", branch]);
            parked.push(branch.slice(AGENT.length));
        } catch {
            await git(main, ["update-ref", "-d", parkedRef(branch)]).catch(() => undefined);
        }
    }
    return parked;
};

// Moves a parked branch back onto `refs/heads/`, a no-op for one that never left; required before `git worktree add`,
// which would otherwise check the commit out detached.
export const unparkAgentRef = async (main: string, branch: string, git: GitRunner): Promise<void> => {
    const { stdout } = await git(main, ["for-each-ref", "--format=%(objectname)", parkedRef(branch)]);
    const sha = stdout.trim();
    if (sha === "") {
        return;
    }
    await git(main, ["update-ref", `${HEADS}${branch}`, sha]);
    await git(main, ["update-ref", "-d", parkedRef(branch)]);
};

// Drops an agent's commits from this repo for good, used by discard and archive purge.
// Deletes both spellings since the caller does not know which one holds it.
export const dropAgentRef = async (main: string, branch: string, git: GitRunner): Promise<void> => {
    await git(main, ["branch", "-D", branch]).catch(() => undefined);
    await git(main, ["update-ref", "-d", parkedRef(branch)]).catch(() => undefined);
};

// Sweeps parked refs whose registry entry is gone; such a ref holds unreachable commits.
// Returns how many it dropped.
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

// Whether `ancestor` is reachable from `descendant`, via `git merge-base --is-ancestor`'s exit code; shared by both
// land-side readers so they cannot disagree about what "reachable" means.
export const isAncestor = async (dir: string, ancestor: string, descendant: string, git: GitRunner): Promise<boolean> => {
    try {
        await git(dir, ["merge-base", "--is-ancestor", ancestor, descendant]);
        return true;
    } catch {
        return false;
    }
};
