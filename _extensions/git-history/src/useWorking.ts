import type { GitChange, GitDiffSide } from "@intentic/sandbox-contract/schemas/git/git";
import { computed, type Ref } from "vue";
import { host } from "./host.js";

// This repo's uncommitted work, shown as row zero so the graph's committed history and the Changes panel's uncommitted
// view meet. Reads the workspace-wide `/git/changes` under the panel's own key rather than a route of its own, so the
// row can never disagree with the panel and moves with every push that refreshes it.

export function useWorking(repo: Ref<string>) {
    const api = host();

    const { query } = api.sandbox.query({
        // Not keyed by repo: the response covers the whole workspace, so per-repo keys would refetch the same scan.
        queryKey: api.sandbox.readKey(`git.changes`),
        queryFn: () => api.sandbox.rpc.git.changes(),
    });

    // A repo with nothing uncommitted is simply absent from the response, same as an empty change set.
    const mine = computed(() => query.data.value?.repos.find((entry) => entry.repo === repo.value));

    // Conflicts lead, as in the Changes panel: an unmerged path blocks every commit and outranks the rest.
    const changes = computed<readonly GitChange[]>(() => {
        const entry = mine.value;
        return entry === undefined ? [] : [...entry.conflicted, ...entry.staged, ...entry.unstaged];
    });

    // Resolved by object identity, not path: a path can sit on both sides with different diffs (index-vs-HEAD,
    // worktree-vs-index). Kept as a separate lookup so changes stay exactly what the daemon sent.
    const sideOf = (change: GitChange): GitDiffSide => {
        const entry = mine.value;
        if (entry?.conflicted.includes(change) === true) {
            return `conflicted`;
        }
        return entry?.staged.includes(change) === true ? `staged` : `unstaged`;
    };

    return {
        changes,
        sideOf,
        conflicted: computed(() => mine.value?.conflicted.length ?? 0),
        // Whether row zero should exist at all.
        dirty: computed(() => changes.value.length > 0),
    };
}
