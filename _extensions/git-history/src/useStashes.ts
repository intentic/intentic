import type { GitCommitDiff, StashEntry } from "@intentic/sandbox-contract";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed, type Ref } from "vue";
import { host } from "./host.js";
import { useAsyncAction } from "./useAsyncAction.js";
import { useRefRefresh } from "./useRefRefresh.js";

// This repo's stashes: shown because a stash entry is a commit (sha, time, subject, diff) whose first parent is the
// commit it was taken on. `ref` is positional (`stash@{0}`, `stash@{1}`...) and dropping one renumbers the rest, so
// every verb here invalidates the list rather than trusting old refs.

export function useStashes(repo: Ref<string>) {
    const api = host();
    const queryClient = useQueryClient();

    const key = computed(() => api.sandbox.key(`git-history`, `stashes`, repo.value));
    const query = useQuery({
        queryKey: key,
        queryFn: () => api.sandbox.rpc.git.stashes({ repo: repo.value }),
        enabled: computed(() => api.sandbox.reachable()),
    });
    // `refs/stash` is an ordinary ref, so stashing in a terminal arrives on the same push as a commit.
    useRefRefresh(repo, [`stashes`]);

    const stashes = computed<readonly StashEntry[]>(() => query.data.value?.stashes ?? []);
    const { busy, error: actionError, run } = useAsyncAction();

    const files = (ref: string): Promise<GitCommitDiff> => api.sandbox.rpc.git.stashDiff({ repo: repo.value, ref });

    // Applying, popping and dropping all invalidate both caches, since a renumbered list read against old refs would
    // act on the wrong entry.
    const invalidate = (): Promise<unknown> =>
        Promise.all([
            queryClient.invalidateQueries({ queryKey: key.value }),
            queryClient.invalidateQueries({ queryKey: api.sandbox.key(`git-history`, `working`) }),
        ]);

    return {
        stashes,
        files,
        busy,
        actionError,
        // `pop` consumes the entry, `apply` keeps it; a conflict comes back as `ok: false` with the entry intact, worth
        // reporting rather than throwing.
        apply: (ref: string, pop: boolean): Promise<void> =>
            run(async () => {
                const result = await api.sandbox.rpc.git.stashApply({ repo: repo.value, ref, pop });
                await invalidate();
                if (!result.ok) {
                    throw new Error(`Could not apply cleanly: resolve the conflict in the Changes panel. The stash is still there.`);
                }
            }, `Could not apply that stash.`),
        drop: (ref: string): Promise<void> =>
            run(async () => {
                await api.sandbox.rpc.git.stashDrop({ repo: repo.value, ref });
                await invalidate();
            }, `Could not drop that stash.`),
    };
}
