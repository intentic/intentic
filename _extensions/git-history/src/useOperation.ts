import { type GitActionResult, GitActionResultSchema, type GitOperation, GitOperationStateSchema } from "@intentic/sandbox-contract";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed, type Ref } from "vue";
import { host } from "./host.js";
import { useAsyncAction } from "./useAsyncAction.js";
import { useRefRefresh } from "./useRefRefresh.js";

/* WHETHER THIS REPO IS HALTED MID-OPERATION, and the way out.
 *
 * The graph is where a stuck repo is most visible and least explicable: HEAD sits somewhere unexpected, a rebase
 * has replayed half its commits, and none of it says why. Nothing this extension starts can cause it — every
 * write it makes aborts cleanly on failure daemon-side — so this is always what a terminal left behind, which is
 * exactly why the graph has to surface it rather than assume its own actions are the only ones.
 *
 * Refreshed off the ref push rather than polled: the markers this reads are written in the git dir, so starting
 * or aborting an operation moves refs (or the in-progress markers the watcher also watches) and the frame
 * arrives on its own. */

const encode = (value: string): string => encodeURIComponent(value);

export function useOperation(repo: Ref<string>) {
    const api = host();
    const queryClient = useQueryClient();

    const key = computed(() => api.sandbox.key(`git-history`, `operation`, repo.value));
    const query = useQuery({
        queryKey: key,
        queryFn: async () => GitOperationStateSchema.parse(await api.sandbox.json(`/git/${encode(repo.value)}/operation`)),
        enabled: computed(() => api.sandbox.reachable()),
    });
    useRefRefresh(repo, [`operation`]);

    const { busy, error: actionError, run } = useAsyncAction();

    // Aborting rewrites the worktree AND moves HEAD, so the log goes with it — the ref push covers every other
    // browser, but this one should not wait a round trip to see its own click land.
    const abort = (): Promise<void> =>
        run(async () => {
            const result: GitActionResult = GitActionResultSchema.parse(
                await api.sandbox.json(`/git/${encode(repo.value)}/abort`, { method: `POST`, headers: { "content-type": `application/json` }, body: `{}` }),
            );
            if (!result.ok) {
                // Someone else finished or aborted it between the render and the click. Nothing to report as a
                // failure — refreshing below simply drops the banner.
                await queryClient.invalidateQueries({ queryKey: key.value });
                return;
            }
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: key.value }),
                queryClient.invalidateQueries({ queryKey: api.sandbox.key(`git-history`, `log`, repo.value) }),
                queryClient.invalidateQueries({ queryKey: api.sandbox.key(`git-history`, `branches`, repo.value) }),
            ]);
        }, `Could not abort — try it in a terminal.`);

    return {
        operation: computed<GitOperation | undefined>(() => query.data.value?.operation),
        busy,
        actionError,
        abort,
    };
}
