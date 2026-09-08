import type { GitOperation } from "@intentic/sandbox-contract";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed, type Ref } from "vue";
import { host } from "./host.js";
import { useAsyncAction } from "./useAsyncAction.js";
import { useRefRefresh } from "./useRefRefresh.js";

// Whether this repo is halted mid-operation (a stuck rebase, HEAD somewhere unexpected), and the way out. Nothing this
// extension does can cause it, since its own writes always abort cleanly, so this always reflects something a terminal
// left behind. Refreshed off the ref push, since starting or aborting an operation moves refs.

export function useOperation(repo: Ref<string>) {
    const api = host();
    const queryClient = useQueryClient();

    const key = computed(() => api.sandbox.key(`git-history`, `operation`, repo.value));
    const query = useQuery({
        queryKey: key,
        queryFn: () => api.sandbox.rpc.git.operation({ repo: repo.value }),
        enabled: computed(() => api.sandbox.reachable()),
    });
    useRefRefresh(repo, [`operation`]);

    const { busy, error: actionError, run } = useAsyncAction();

    // Aborting rewrites the worktree and moves HEAD, so the log needs refreshing too; other tabs get that via the ref
    // push, but this one shouldn't wait a round trip for its own click.
    const abort = (): Promise<void> =>
        run(async () => {
            const result = await api.sandbox.rpc.git.abort({ repo: repo.value });
            if (!result.ok) {
                // Someone else already finished or aborted it; refreshing here just drops the banner.
                await queryClient.invalidateQueries({ queryKey: key.value });
                return;
            }
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: key.value }),
                queryClient.invalidateQueries({ queryKey: api.sandbox.key(`git-history`, `log`, repo.value) }),
                queryClient.invalidateQueries({ queryKey: api.sandbox.key(`git-history`, `branches`, repo.value) }),
            ]);
        }, `Could not abort: try it in a terminal.`);

    return {
        operation: computed<GitOperation | undefined>(() => query.data.value?.operation),
        busy,
        actionError,
        abort,
    };
}
