<script setup lang="ts">
import type { SandboxSummary } from "@intentic/api-contract";
import { ConfirmDialog, Notice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { useSandbox } from "../../../../client/sandbox/useSandbox";
import { rollBackHosted } from "./hostedRollback";
import { useOperation } from "../../../../workbench/operations/operations";

// The one question before a hosted sandbox goes back to the version it ran before its last update, asked wherever that
// is offered: the update card, the sandbox switcher and the panel shown while the sandbox is down. Open while
// `sandbox` names one; it stays open on a refusal so the reason is read where the press was made.

const t = useT();

const { sandbox } = defineProps<{ sandbox: SandboxSummary | undefined }>();
const emit = defineEmits<{ close: [] }>();

const { refresh } = useSandbox();
// Per sandbox gone back, since the switcher offers it for any of them: the dialog opened again on the same one while
// the ask is out holds its button, and a refusal is still there to read.
const rollback = useOperation(() => `sandbox/hosted-rollback/${sandbox?.id ?? `none`}`);
const busy = rollback.busy;
const notice = rollback.failure;

const confirm = async (): Promise<void> => {
    const target = sandbox;
    if (target === undefined || busy.value) {
        return;
    }
    const outcome = await rollback.run({
        what: t(`capabilities.hostRecreate.rollingSandboxBack`),
        failed: t(`sandbox.hostedRollback.couldntRollBack`),
        // Its end is the sandbox restarting onto the older image, which says so by itself.
        quiet: true,
        task: async () => {
            await rollBackHosted(target.id);
            // The row says whether there is anything left to go back to; read it again rather than guess. Not waited
            // on, and its own failure is not the rollback's: the dialog closes on the platform's yes.
            // allow(silent-catch): a refresh that fails leaves the row as it was, which the next read corrects.
            void refresh().catch(() => undefined);
        },
    });
    if (outcome?.state === `done`) {
        emit(`close`);
    }
};
</script>

<template>
    <!-- Not destructive: the files stay, and only the image the machine boots changes. -->
    <ConfirmDialog
        :open="sandbox !== undefined"
        :header="t(`sandbox.hostedRollback.header`, { name: sandbox?.name ?? `` })"
        :description="t(`sandbox.hostedRollback.body`)"
        :confirm-label="t(`capabilities.hostRecreate.rollBackVerb`)"
        confirm-icon="undo"
        :destructive="false"
        :loading="busy"
        @cancel="emit(`close`)"
        @confirm="confirm"
    >
        <Notice v-if="notice" :of="notice" />
    </ConfirmDialog>
</template>
