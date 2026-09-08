import type { GitBranch, GitRemoteBranch } from "@intentic/sandbox-contract";

// Groups a local branch with its remote counterparts by name, not by configured upstream: a branch whose upstream is
// gone, or that was never pushed, still lines up with same-named remotes. A remote-only branch gets a group with no
// local, the row a checkout would start from.

export interface BranchGroup {
    // The shared name (`main`, `feature/x`), the group's heading and its identity.
    readonly name: string;
    readonly local?: GitBranch;
    readonly remotes: readonly GitRemoteBranch[];
    // Newest tip in the group, for ordering: whichever side (local or remote) has the newer commit.
    readonly at: number;
}

// Mutated in place; becomes the readonly BranchGroup once built, so there is no separate remap step.
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

    // Current branch first, then newest tip first.
    return [...groups.values()].toSorted((a, b) => Number(b.local?.current ?? false) - Number(a.local?.current ?? false) || b.at - a.at);
};
