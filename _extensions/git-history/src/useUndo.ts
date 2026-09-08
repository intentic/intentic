import type { UndoableAction } from "@intentic/sandbox-contract";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed, type Ref } from "vue";
import { host } from "./host.js";
import { useAsyncAction } from "./useAsyncAction.js";
import { useRefRefresh } from "./useRefRefresh.js";

// The last thing that moved this branch, and the button to walk it back. Distinct from the Checkpoints timeline, which
// restores the working tree; this moves the branch instead, so already-fixed files aren't dragged back. Refreshed off
// the ref push, so a stale button can't misname the last action.

// Button label per action kind; the longer reflog subject rides the tooltip instead.
const VERBS: Record<UndoableAction["kind"], string> = {
    commit: `commit`,
    amend: `amend`,
    merge: `merge`,
    rebase: `rebase`,
    "cherry-pick": `cherry-pick`,
    revert: `revert`,
    reset: `reset`,
    pull: `pull`,
    other: `last action`,
};

export function useUndo(repo: Ref<string>) {
    const api = host();
    const queryClient = useQueryClient();

    const key = computed(() => api.sandbox.key(`git-history`, `undo`, repo.value));
    const query = useQuery({
        queryKey: key,
        queryFn: () => api.sandbox.rpc.git.undoable({ repo: repo.value }),
        enabled: computed(() => api.sandbox.reachable()),
    });
    useRefRefresh(repo, [`undo`]);

    const action = computed<UndoableAction | undefined>(() => query.data.value?.action);
    const { busy, error: actionError, run } = useAsyncAction();

    // `discardChanges` chooses hard vs soft reset (soft keeps files, hard restores the tree too); the caller decides
    // per situation. `previousSha` is a concurrency token: the daemon refuses the undo if the repo moved since.
    const undo = (discardChanges: boolean): Promise<void> =>
        run(async () => {
            const target = action.value;
            if (target === undefined) {
                return;
            }
            const result = await api.sandbox.rpc.git.undo({ repo: repo.value, previousSha: target.previousSha, discardChanges });
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: key.value }),
                queryClient.invalidateQueries({ queryKey: api.sandbox.key(`git-history`, `log`, repo.value) }),
                queryClient.invalidateQueries({ queryKey: api.sandbox.key(`git-history`, `branches`, repo.value) }),
            ]);
            if (!result.ok) {
                // A refusal is worth showing, usually meaning the repository moved since this undo was prepared.
                throw new Error(result.reason ?? `Could not undo.`);
            }
        }, `Could not undo.`);

    return {
        action,
        // "Undo commit", "Undo rebase": the verb, so the button says what it does without a hover.
        label: computed(() => (action.value === undefined ? undefined : `Undo ${VERBS[action.value.kind]}`)),
        busy,
        actionError,
        undo,
    };
}
