import type { GitBranch, GitRemoteBranch } from "@intentic/sandbox-contract";

/* PAIRING A LOCAL BRANCH WITH ITS REMOTE COUNTERPARTS.
 *
 * `main` and `origin/main` are one branch as far as a reader is concerned, the same line of work, seen locally
 * and on a remote, so listing them as two peers doubles the switcher's length and asks the reader to notice a
 * prefix to tell them apart. Grouped, `main` is one row that happens to also exist on origin.
 *
 * Pairing is by NAME rather than by the local branch's configured upstream, and that is deliberate: a branch
 * whose upstream is gone (a merged PR's deleted remote branch) still belongs beside the remote branches sharing
 * its name, and a local branch that has never been pushed should still sit under the same heading as the remote
 * branch someone else pushed under that name. The upstream is a fact ABOUT the local branch, which it already
 * carries; it is not the identity of the line of work.
 *
 * A remote-only branch gets a group with no local, that is how "somebody pushed a branch you do not have" is
 * visible at all, and it is the row a checkout would be created from. */

export interface BranchGroup {
    // The shared name (`main`, `feature/x`), the group's heading and its identity.
    readonly name: string;
    readonly local?: GitBranch;
    readonly remotes: readonly GitRemoteBranch[];
    // Newest tip in the group, for ordering: what you last worked on should be near the top whether the newest
    // commit landed locally or on a remote.
    readonly at: number;
}

// Built mutably and read as the readonly BranchGroup, the accumulator IS the result here, so remapping it
// afterwards would allocate a second object per branch to change nothing.
type Building = { name: string; local?: GitBranch; remotes: GitRemoteBranch[]; at: number };

export const groupBranches = (locals: readonly GitBranch[], remotes: readonly GitRemoteBranch[]): readonly BranchGroup[] => {
    const groups = new Map<string, Building>();
    const upsert = (name: string, at: number): Building => {
        const existing = groups.get(name);
        if (existing !== undefined) {
            existing.at = Math.max(existing.at, at);
            return existing;
        }
        const created: Building = { name, remotes: [], at };
        groups.set(name, created);
        return created;
    };

    for (const local of locals) {
        upsert(local.name, local.at).local = local;
    }
    for (const remote of remotes) {
        upsert(remote.branch, remote.at).remotes.push(remote);
    }

    // Current branch first, it is the one row the reader is always looking for, then newest tip first, which
    // is the order the daemon already sorts each list in and the one a switcher wants.
    return [...groups.values()].toSorted((a, b) => Number(b.local?.current ?? false) - Number(a.local?.current ?? false) || b.at - a.at);
};
