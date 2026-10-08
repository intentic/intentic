import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { ahead, syncable, unpublished } from "../../push/outgoingWork";
import { commitMessage } from "./commitMessage";
import { COMMIT_SCOPE, useChanges } from "../useChanges";
import { useCommitScope } from "./useCommitScope";

export const useCommitReceipt = () => {
    const t = useT();
    const changes = useChanges();
    const { scannable } = useCommitScope();

    // The receipt of the last commit this tab recorded, with the way back: a soft reset, so its files return staged and
    // its message returns to the box. Offered only while no remote holds it, since walking a pushed commit back would
    // need a force push to follow.
    // A repo the scan no longer lists is clean with nothing to sync: still undoable when it had no remote, already held by
    // its remote when it did.
    const receipt = computed(() => changes.lastCommit.value);
    const receiptUndoable = computed(() => {
        const commits = receipt.value?.commits ?? [];
        return (
            commits.length > 0 &&
            commits.every((commit) => {
                const repo = scannable.value.find((entry) => entry.repo === commit.repo);
                return repo === undefined ? !commit.remote : !syncable(repo) || unpublished(repo) || ahead(repo) > 0;
            })
        );
    });
    const receiptLine = computed<string | undefined>(() => {
        const held = receipt.value;
        if (held === undefined) {
            return undefined;
        }
        const sha = held.commits.length === 1 ? held.commits[0]!.sha.slice(0, 7) : undefined;
        const verb = held.amend
            ? t(`workspace.reviewPanel.amendedAs`, { sha: sha ?? `` })
            : t(`workspace.reviewPanel.committedAs`, { sha: sha ?? `` });
        return sha === undefined ? t(`workspace.reviewPanel.committedInRepos`, { count: held.commits.length }, held.commits.length) : verb;
    });
    const undoReceipt = async (): Promise<void> => {
        const held = receipt.value;
        if (held === undefined) {
            return;
        }
        await changes.undoCommit(held);
        // The words come back too, unless the box already holds new ones.
        if (!changes.failures.value.has(COMMIT_SCOPE) && commitMessage.value.trim().length === 0 && !held.amend) {
            commitMessage.value = held.message;
        }
    };

    return { receipt, receiptUndoable, receiptLine, undoReceipt };
};
