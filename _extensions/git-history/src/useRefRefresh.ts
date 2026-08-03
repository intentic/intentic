import { useQueryClient } from "@tanstack/vue-query";
import { onScopeDispose, type Ref } from "vue";
import { host } from "./host.js";

/* KEEP THIS REPO'S QUERIES FRESH WHILE SOMEONE IS LOOKING AT THEM.
 *
 * Almost every commit in this workspace is the AGENT's — made out-of-band, with no request from this browser to
 * invalidate against — so a graph without this shows whatever was true when the tab was opened. The host's ref
 * push is the only channel that can carry it: git dirs do not live under /work and the file watcher ignores
 * `.git` besides, so no `contributes.files` prefix could ever match one.
 *
 * Scoped to the caller's effect scope rather than to activation, and that is the right lifetime rather than a
 * compromise: vue-query refetches a stale query on mount anyway, so a tab that was closed when the commit landed
 * comes back fresh on its own. What needs a live subscription is the tab that is OPEN while the agent works —
 * which is exactly when a component scope exists.
 *
 * Only the named repos are invalidated. A frame says what moved, so a busy repo never costs the others a refetch.
 */
export const useRefRefresh = (repo: Ref<string>, keys: readonly string[]): void => {
    const api = host();
    const queryClient = useQueryClient();
    const stop = api.workspace.onDidChangeRefs((repos) => {
        if (!repos.includes(repo.value)) {
            return;
        }
        for (const key of keys) {
            void queryClient.invalidateQueries({ queryKey: api.sandbox.key(`git-history`, key, repo.value) });
        }
    });
    onScopeDispose(() => stop.dispose());
};
