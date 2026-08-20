import type { RepoChanges } from "@intentic-app/api-contract";

/* WHAT A CLEAN TREE STILL OWES, the remote-state layer under the Changes panel, the Workspace rail tile, the
 * sidebar's Changes tab and the mobile Review tab.
 *
 * It exists because "nothing to review" and "nothing to do" are different facts, and only the first of them was
 * ever visible: the review count deliberately excludes a repo that is merely unpushed (it has no reviewable
 * work), so a tree whose commits exist on this disk alone went completely silent everywhere outside the panel.
 * On a workspace where AGENTS commit, "the user knows, they committed it" is not true.
 *
 * Pure functions over one response, in their own module rather than inside useChanges: the composable pulls the
 * chat singleton and the query client in with it, and the rules here are worth being able to state on their own. */

/* Where ONE repo stands against its remote, in the terms the surfaces ask in. Shared rather than re-derived,
 * because four surfaces asking "is this repo ahead" out of the raw fields is how four surfaces drift apart.
 * Absent reads as zero/false rather than throwing: every one of these fields is legitimately missing in a
 * healthy repo, no remote configured, a branch created locally and never pushed, a detached HEAD (see
 * GitRemoteStateSchema). */
export const syncable = (repo: RepoChanges): boolean => repo.remote?.remote !== undefined;
export const ahead = (repo: RepoChanges): number => repo.remote?.ahead ?? 0;
export const behind = (repo: RepoChanges): number => repo.remote?.behind ?? 0;
// A branch on a repo that HAS a remote but tracks nothing on it. Its own state rather than a large `ahead`:
// git reports no count for an untracked branch, so the amount is unsayable and the verb is Publish.
export const unpublished = (repo: RepoChanges): boolean => syncable(repo) && repo.remote?.upstream === undefined;

/* Work that exists on this disk and nowhere else, across every repo.
 *
 * OUTGOING ONLY, deliberately. `behind` is true only as of the last fetch, so a surface driven by it announces
 * incoming work that has already been taken and stays quiet about work that has just arrived, wrong in both
 * directions, which is worse than absent. `ahead` and "no upstream yet" are facts the local repo holds by
 * itself, and they are the ones carrying the risk: a sandbox is a machine that can go away. Pull stays inside
 * the panel, next to the Fetch that makes it trustworthy. */
export interface OutgoingWork {
    // Commits ahead of their upstream, summed across repos. 0 when the only outgoing work is an unpublished
    // branch, whose commits have no upstream to be counted against.
    readonly commits: number;
    // How many repos carry outgoing work, git cannot span remotes, so sending it is one push per repo.
    readonly repos: number;
    // At least one branch has never been pushed, so the verb the user will meet is Publish rather than Push.
    readonly publish: boolean;
}

// Every repo with something to send. A repo git could not scan is left out: its remote state is as unknown as
// everything else about it, and the panel reports the scan failure itself, the same `error === undefined`
// split every action in the panel is scoped by. Undefined when there is nothing to send anywhere.
export const outgoingWork = (repos: readonly RepoChanges[]): OutgoingWork | undefined => {
    const sending = repos.filter((repo) => repo.error === undefined && (ahead(repo) > 0 || unpublished(repo)));
    if (sending.length === 0) {
        return undefined;
    }
    return {
        commits: sending.reduce((total, repo) => total + ahead(repo), 0),
        repos: sending.length,
        publish: sending.some(unpublished),
    };
};

// The glyph that stands for outgoing work, wherever it is shown. `cloud-upload` only when publishing is ALL
// there is to do, a branch that is both unpublished and ahead is sent by the same push as any other, so it
// wears the arrow. Both are the review panel's own (SYNC_VERB), which is what lets the rail, the sidebar tab
// and the sync bar read as one language instead of three vocabularies for one fact.
export const outgoingMark = ({ commits }: OutgoingWork): "arrow-up-right" | "cloud-upload" => (commits === 0 ? `cloud-upload` : `arrow-up-right`);

// The one sentence every surface says about outgoing work. A glyph on a tile can only say THAT something is
// waiting; this is where the amount goes, and the amount is what decides whether the user acts now or later.
export const outgoingSummary = ({ commits, repos }: OutgoingWork): string => {
    if (commits === 0) {
        return `${repos === 1 ? `A branch has` : `${repos} branches have`} never been pushed`;
    }
    // A repo that is both unpublished and ahead is described by its commits alone, mirroring the panel's own
    // verb: the per-repo fan-out publishes the untracked branches on the way through, so spelling out both
    // would describe two actions where the user has one click.
    return `${commits} ${commits === 1 ? `commit` : `commits`}${repos === 1 ? `` : ` across ${repos} repos`} waiting to push`;
};
