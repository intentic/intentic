import { useQueryClient } from "@tanstack/vue-query";
import { ref } from "vue";
import { sandboxRpc } from "../../sandbox/client/sandboxRpc";
import { rpcPrefix, workingReviewKeys } from "../../../lib/queryKeys";
import { repoNameFromUrl } from "../health/repoName";

// Clones a repository into the workspace, landing at /work/<name> derived from the URL. The daemon reserves some names
// and validates the rest, so its verdict is what counts; nothing is pre-validated here beyond having a name to send.

export function useAddRepo() {
    const queryClient = useQueryClient();
    const cloning = ref(false);
    const error = ref<string | undefined>(undefined);

    // Clones, then invalidates everything a new repo changes: file tree, panel list, repo list, changes scan. Returns
    // whether it landed, so the caller can close on success or keep the URL on failure.
    const addRepo = async (cloneUrl: string): Promise<boolean> => {
        // Guards Enter re-submitting mid-clone: Enter in the field doesn't go through the button's disabled state.
        if (cloning.value) {
            return false;
        }
        const url = cloneUrl.trim();
        const name = repoNameFromUrl(url);
        if (url.length === 0 || name.length === 0) {
            error.value = `That doesn't look like a repository address.`;
            return false;
        }
        cloning.value = true;
        error.value = undefined;
        try {
            await sandboxRpc.workspace.addRepo({ name, cloneUrl: url });
            await Promise.all(
                [rpcPrefix(`workspace.tree`), rpcPrefix(`panels.list`), rpcPrefix(`git.repos`), ...workingReviewKeys].map((queryKey) =>
                    queryClient.invalidateQueries({ queryKey }),
                ),
            );
            return true;
        } catch (cause) {
            // Daemon's own message: knows whether it's a reserved name, unreachable host, or missing credentials.
            error.value = cause instanceof Error ? cause.message : `Couldn't clone that repository.`;
            return false;
        } finally {
            cloning.value = false;
        }
    };

    return { addRepo, cloning, error };
}
