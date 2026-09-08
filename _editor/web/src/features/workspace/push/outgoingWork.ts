import type { RepoChanges } from "@intentic/api-contract";

// Remote-state layer under the Changes panel, rail tile, sidebar tab, and mobile Review tab. Exists because the
// review count excludes unpushed work, so "nothing to review" isn't "nothing to do", especially when agents
// commit unseen. Pure functions in their own module, since useChanges also pulls in the chat singleton and query
// client.

// Shared rather than re-derived per surface, so four readings of "is this repo ahead" can't drift apart.
// Absent reads as zero/false; each field is legitimately missing in a healthy repo (no remote, unpushed, detached
// HEAD).
export const syncable = (repo: RepoChanges): boolean => repo.remote?.remote !== undefined;
export const ahead = (repo: RepoChanges): number => repo.remote?.ahead ?? 0;
export const behind = (repo: RepoChanges): number => repo.remote?.behind ?? 0;
// A branch with a remote but no upstream; its own state, not a large `ahead`, since git reports no count for
// an untracked branch.
export const unpublished = (repo: RepoChanges): boolean => syncable(repo) && repo.remote?.upstream === undefined;

// Work that exists on this disk and nowhere else. Outgoing only: `behind` is only as fresh as the last fetch,
// so acting on it would be wrong in both directions; `ahead` and an unpublished branch are risks the sandbox alone
// carries.
export interface OutgoingWork {
    // Commits ahead of upstream, summed across repos; 0 when the only work is an unpublished branch to count.
    readonly commits: number;
    // How many repos carry outgoing work; git can't span remotes, so sending it is one push per repo.
    readonly repos: number;
    // At least one branch has never been pushed, so the verb the user meets is Publish, not Push.
    readonly publish: boolean;
}

// Every repo with something to send; one git couldn't scan is left out, since its remote state is as unknown
// as everything else and the panel already reports the scan failure. Undefined when nothing needs sending.
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

// The glyph for outgoing work everywhere it's shown. `cloud-upload` only when publishing is all there is; an
// unpublished-and-ahead branch is sent by the same push as any other, so it wears the arrow.
export const outgoingMark = ({ commits }: OutgoingWork): "arrow-up-right" | "cloud-upload" => (commits === 0 ? `cloud-upload` : `arrow-up-right`);

// The one sentence every surface says about outgoing work; a glyph alone can only say something is waiting,
// and the amount decides whether the user acts now or later.
export const outgoingSummary = ({ commits, repos }: OutgoingWork): string => {
    if (commits === 0) {
        return `${repos === 1 ? `A branch has` : `${repos} branches have`} never been pushed`;
    }
    // Described by its commits alone when both unpublished and ahead: the fan-out publishes on the way through.
    return `${commits} ${commits === 1 ? `commit` : `commits`}${repos === 1 ? `` : ` across ${repos} repos`} waiting to push`;
};
