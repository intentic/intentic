<script setup lang="ts">
import type { SandboxSummary } from "@intentic/api-contract";
import { Button, Modal } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { ref } from "vue";
import { useRouter } from "vue-router";
import { useSandbox } from "../../../../client/sandbox/useSandbox";
import { NOTHING_TO_OPEN_PATH } from "../../../../app/environments/nothingToOpen";
import { askRemoveSandbox, closeRemoveSandbox, removeSandboxAsked } from "../../../../models/sandbox/removeSandbox";
import RemoveSandboxDialog from "./RemoveSandboxDialog.vue";

// THE WINDOW'S ONE REMOVE SANDBOX DIALOG (models/sandbox/removeSandbox.ts), mounted by the shell above every page: the
// sandbox's settings and the gates ask for it, and removing the sandbox on screen switches to another one, which would
// take a dialog mounted by the page that asked along with it. The run itself is in the operations ledger, so this only
// says which sandbox the dialog is about; opening it on a sandbox whose removal is under way shows that removal.

const t = useT();
const router = useRouter();
const sandbox = useSandbox();

// A sandbox that was left on the account but could not be asked to take this person off its own member list, so it still
// lists them: said until it is dismissed, since the row it would have been said on is gone.
const stillListed = ref<{ readonly name: string; readonly reason: string }>();

// Drops the account row (a member first leaves the sandbox's own list); with none left, the reader goes to Home's first
// run, as the shell's gate has it (app/environments/nothingToOpen.ts).
const removeRow = async (target: SandboxSummary): Promise<void> => {
    const outcome = await sandbox.remove(target.id);
    // Only once the row is really gone: leaving for the setup on the optimistic drop took the reader off the shell, and
    // the dialog with it, before a refusal could bring the row back and say why.
    if (sandbox.sandboxes.value.length === 0) {
        void router.push(NOTHING_TO_OPEN_PATH);
    }
    if (outcome?.grant === `kept`) {
        stillListed.value = { name: target.name, reason: outcome.reason };
    }
};
</script>

<template>
    <RemoveSandboxDialog :target="removeSandboxAsked" :remove-row="removeRow" @close="closeRemoveSandbox" @reopen="askRemoveSandbox" />
    <Modal
        :open="stillListed !== undefined"
        size="sm"
        :header="t(`sandbox.sandboxSwitcher.leftStillListedHeader`)"
        :description="stillListed === undefined ? undefined : t(`sandbox.sandboxSwitcher.leftStillListed`, stillListed)"
        @update:open="(open: boolean) => open || (stillListed = undefined)"
    >
        <template #footer>
            <Button :label="t(`ui.action.done`)" tier="accent" @click="stillListed = undefined" />
        </template>
    </Modal>
</template>
