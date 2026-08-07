import type { GitChange, GitDiffSide } from "@intentic/sandbox-contract";
import { useQuery } from "@tanstack/vue-query";
import { computed, type Ref } from "vue";
import { host } from "./host.js";

/* THIS REPO'S UNCOMMITTED WORK — the top row of the graph.
 *
 * The graph is the committed side of the real-git story and the Changes panel is the uncommitted side, and the
 * seam between them was a real gap: the newest thing in the repository was never the newest thing in the graph.
 * Row zero closes it, the way VSCode's own graph does.
 *
 * Read from the workspace-wide `/git/changes` rather than a per-repo route of its own, and that is the point
 * rather than a shortcut: it is the exact response the app's Changes panel renders, so the row and the panel can
 * never disagree about what is uncommitted. The daemon coalesces that scan, so the extra reader is close to
 * free, and the panel is usually driving refetches of it anyway. */

export function useWorking(repo: Ref<string>) {
    const api = host();

    const query = useQuery({
        // Not keyed by repo: the response covers the whole workspace, so keying per repo would fetch the same
        // scan once per open graph.
        queryKey: api.sandbox.key(`git-history`, `working`),
        queryFn: () => api.sandbox.rpc.git.changes({}),
        enabled: computed(() => api.sandbox.reachable()),
    });

    // A repo with nothing uncommitted is absent from the response entirely (the panel lists only repos with
    // something to show), which is the same as a repo with an empty change set.
    const mine = computed(() => query.data.value?.repos.find((entry) => entry.repo === repo.value));

    /* Conflicts lead, for the reason the Changes panel leads with them: an unmerged path blocks every commit in
     * the repo, so it outranks everything else in the list. */
    const changes = computed<readonly GitChange[]>(() => {
        const entry = mine.value;
        return entry === undefined ? [] : [...entry.conflicted, ...entry.staged, ...entry.unstaged];
    });

    /* WHICH SIDE A ROW CAME FROM, resolved by object IDENTITY rather than by path.
     *
     * It has to be identity: a path can sit on two sides at once with different content (the classic partially
     * staged file), and those are two genuinely different diffs — index-vs-HEAD and worktree-vs-index. A lookup
     * by path would have to pick one of them arbitrarily, and would show the user the wrong half half the time.
     * The same object reference only ever appears in one list, so this cannot be ambiguous.
     *
     * Carried as a lookup rather than merged onto each change so the changes stay exactly what the daemon sent
     * — the file tree takes plain GitChanges, and copying every row to bolt a field on would both allocate per
     * render and put a second spelling of the wire shape into circulation. */
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
