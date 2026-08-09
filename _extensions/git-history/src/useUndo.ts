import type { UndoableAction } from "@intentic/sandbox-contract";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed, type Ref } from "vue";
import { host } from "./host.js";
import { useAsyncAction } from "./useAsyncAction.js";
import { useRefRefresh } from "./useRefRefresh.js";

/* THE LAST THING THAT MOVED THIS BRANCH, and the button that walks it back.
 *
 * Deliberately a different verb from the Checkpoints timeline the app already has: a checkpoint restores the
 * WORKING TREE, this moves the BRANCH. After a rebase that went wrong the files are often already fine and only
 * the ref is in the wrong place — and restoring a whole worktree snapshot to fix that would drag every unrelated
 * edit made since back with it. Which is also why this one is safe to offer prominently: the daemon checkpoints
 * before it resets, so the bigger hammer is still there underneath.
 *
 * Refreshed off the ref push, since the thing it reports IS a ref move — including the agent's, which is the
 * case where a stale Undo button would be most dangerous: it would name an action the user never took. */

// What the button says. Git's reflog subject is the honest description but it is also long and shaped for a log
// ("commit (amend): fix the parser"), so the KIND names the verb and the subject rides the tooltip.
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

    /* `discardChanges` picks a hard reset over a soft one, and the caller decides because both are things people
     * mean by undo: after a commit you usually want the files kept (soft), after a bad rebase you usually want
     * the tree back too (hard). `changesWorkingTree` on the action is what the UI uses to default it.
     *
     * `previousSha` goes back as the concurrency token the read handed out — the daemon refuses the undo if the
     * repository has moved since, so a button rendered a minute ago cannot land somewhere unlooked-at. */
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
                // A refusal is a real answer worth showing — most often "the repository moved since this undo was
                // prepared", which tells the user their view was stale rather than that something broke.
                throw new Error(result.reason ?? `Could not undo.`);
            }
        }, `Could not undo.`);

    return {
        action,
        // "Undo commit", "Undo rebase" — the verb, so the button says what it will do without being hovered.
        label: computed(() => (action.value === undefined ? undefined : `Undo ${VERBS[action.value.kind]}`)),
        busy,
        actionError,
        undo,
    };
}
