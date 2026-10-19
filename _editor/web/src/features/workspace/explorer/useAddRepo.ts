import { useQueryClient } from "@tanstack/vue-query";
import type { NoticeModel } from "@intentic/ui/async";
import { t } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { sandboxRpc } from "../../../client/sandbox/sandboxRpc";
import { rpcPrefix, workingReviewKeys } from "../../../lib/queryKeys";
import { useOperation } from "../../../workbench/operations/operations";
import { repoNameFromUrl } from "../health/repoName";

// Clones a repository into the workspace, landing at /work/<name> derived from the URL. The daemon reserves some names
// and validates the rest, so its verdict is what counts; nothing is pre-validated here beyond having a name to send.

// The clone is the workspace's, not the pane's: the daemon runs `git clone` to the end in one request, which can take
// minutes, and the empty pane that started it is gone the moment a file is opened. Kept in the ledger, coming back
// finds it still cloning (and the press still held, where a second one was refused as "already exists"), or its failure.
export const ADD_REPO = `workspace/add-repo`;

// What the run carries from its press: the address, so a pane that comes back over it shows what is being cloned, and
// after a failure the address to correct rather than retype.
export interface AddRepoProgress {
    readonly url: string;
}

export function useAddRepo() {
    const queryClient = useQueryClient();
    const clone = useOperation<void, NoticeModel, AddRepoProgress>(ADD_REPO);
    // An address with nothing to clone is refused here, before anything is sent: a question about what was typed.
    const refused = ref<NoticeModel | undefined>(undefined);

    // Clones, then invalidates everything a new repo changes: file tree, panel list, repo list, changes scan. Returns
    // whether it landed, so the caller can close on success or keep the URL on failure.
    const addRepo = async (cloneUrl: string): Promise<boolean> => {
        // Guards Enter re-submitting mid-clone: Enter in the field doesn't go through the button's disabled state.
        if (clone.busy.value) {
            return false;
        }
        const url = cloneUrl.trim();
        const name = repoNameFromUrl(url);
        if (url.length === 0 || name.length === 0) {
            clone.dismiss();
            refused.value = { tone: `danger`, title: t(`workspace.useAddRepo.cloneFailed`), detail: t(`workspace.useAddRepo.notAnAddress`) };
            return false;
        }
        refused.value = undefined;
        const outcome = await clone.run({
            what: t(`workspace.useAddRepo.cloning`, { name }),
            done: () => t(`workspace.useAddRepo.cloned`, { name }),
            // The daemon's own message rides as the detail: it knows whether it's a reserved name, an unreachable
            // host, or missing credentials.
            failed: t(`workspace.useAddRepo.cloneFailed`),
            progress: { url },
            task: async () => {
                await sandboxRpc.workspace.addRepo({ name, cloneUrl: url });
                await Promise.all(
                    [rpcPrefix(`workspace.tree`), rpcPrefix(`panels.list`), rpcPrefix(`git.repos`), ...workingReviewKeys].map((queryKey) =>
                        queryClient.invalidateQueries({ queryKey }),
                    ),
                );
            },
        });
        return outcome?.state === `done`;
    };

    return {
        addRepo,
        cloning: clone.busy,
        failure: computed(() => refused.value ?? clone.failure.value),
        // The address of the clone still running, or of the one that failed.
        url: computed(() => clone.progress.value?.url),
        // When the clone still running began, for the pane's clock (components/WaitProgress.vue); undefined otherwise.
        startedAt: computed(() => (clone.busy.value ? clone.operation.value?.startedAt : undefined)),
    };
}
