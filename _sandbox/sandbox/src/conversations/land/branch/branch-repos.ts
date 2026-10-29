import type { PersistedAgent, WorktreePlacement } from "../../registry/agents-store.js";

// A CONVERSATION STARTED FROM A BRANCH (2026-10-29). Its copy of one repository was cut from a branch's tip rather than
// the main line, follows that branch, and its land commits onto it (branch-land.ts), never into the shared checkout,
// which stays on its main line (git/main-line-lock.ts). Latched on the placement at the opening compose as `branches`;
// every other repo of the same conversation follows the main line for context, but has no landing destination. A branch
// commit refuses changes in those repos before writing anything. Main-tree land readers (origins, presence and the
// version commit) leave the whole conversation be.

/** The branch this repo of the conversation lands onto, undefined for one that follows the main line. */
export const branchOf = (placement: Pick<WorktreePlacement, "branches"> | undefined, repo: string): string | undefined =>
    placement?.branches?.find((started) => started.repo === repo)?.branch;

/** One live conversation's start from a branch: what must not be taken from under it (a delete, the idle sweep). */
export interface BranchStart {
    readonly conversationId: string;
    readonly title: string | undefined;
    readonly repo: string;
    readonly branch: string;
}

/** Every branch a live (not archived) conversation was started from and lands onto. */
export const liveBranchStarts = (agents: { readonly ids: () => readonly string[]; readonly entry: (id: string) => PersistedAgent | undefined }): BranchStart[] =>
    agents.ids().flatMap((id) => {
        const entry = agents.entry(id);
        if (entry === undefined || entry.archivedAt !== undefined || entry.placement.kind !== "worktree") {
            return [];
        }
        return (entry.placement.branches ?? []).map(({ repo, branch }) => ({ conversationId: id, title: entry.social.title?.text, repo, branch }));
    });

/** The repos whose land reaches the shared tree: none for a conversation that commits onto branches. */
export const mainTreeRepos = <Repo extends { readonly repo: string }>(placement: Pick<WorktreePlacement, "branches"> & { readonly repos: readonly Repo[] }): Repo[] =>
    (placement.branches?.length ?? 0) > 0 ? [] : [...placement.repos];
