import { useQueryClient } from "@tanstack/vue-query";
import { onScopeDispose, type Ref } from "vue";
import { host } from "./host.js";

// Keeps this repo's queries fresh while a tab has it open, since most commits here are the agent's own with nothing
// local to invalidate against. The host's ref push is the only signal (git dirs sit outside the file watcher's reach).
// Scoped to the caller's effect scope; only the named repos are invalidated.
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
