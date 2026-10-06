<script setup lang="ts">
import type { SandboxSummary } from "@intentic/api-contract";
import { ConfirmDialog, Notice } from "@intentic/ui";
import { useAsyncAction } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { useSandbox } from "../../../../client/sandbox/useSandbox";
import { rollBackHosted } from "./hostedRollback";

// The one question before a hosted sandbox goes back to the version it ran before its last update, asked wherever that
// is offered: the update card, the sandbox switcher and the panel shown while the sandbox is down. Open while
// `sandbox` names one; it stays open on a refusal so the reason is read where the press was made.

const t = useT();

const { sandbox } = defineProps<{ sandbox: SandboxSummary | undefined }>();
const emit = defineEmits<{ close: [] }>();

const { refresh } = useSandbox();
const { busy, notice, run } = useAsyncAction();

const confirm = (): Promise<void> =>
    run(async () => {
        const target = sandbox;
        if (target === undefined) {
            return;
        }
        await rollBackHosted(target.id);
        emit(`close`);
        // The row says whether there is anything left to go back to; read it again rather than guess.
        await refresh();
    }, t(`sandbox.hostedRollback.couldntRollBack`));
</script>

<template>
    <!-- Not destructive: the files stay, and only the image the machine boots changes. -->
    <ConfirmDialog
        :open="sandbox !== undefined"
        :header="t(`sandbox.hostedRollback.header`, { name: sandbox?.name ?? `` })"
        :confirm-label="t(`capabilities.hostRecreate.rollBackVerb`)"
        confirm-icon="undo"
        :destructive="false"
        :loading="busy"
        @cancel="emit(`close`)"
        @confirm="confirm"
    >
        <p>{{ t(`sandbox.hostedRollback.body`) }}</p>
        <Notice v-if="notice" :of="notice" class="mt-3" />
    </ConfirmDialog>
</template>
