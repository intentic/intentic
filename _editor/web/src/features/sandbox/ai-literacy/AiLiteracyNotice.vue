<script setup lang="ts">
import { errorMessage } from "@intentic/base/errors";
import { AiLiteracyLocaleSchema } from "@intentic/sandbox-contract/schemas/ai-literacy";
import { Button, Modal, Notice } from "@intentic/ui";
import { activeLocale, useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { rpcQuery } from "../../../client/sandbox/rpcQuery";
import { sandboxRpc } from "../../../client/sandbox/sandboxRpc";
import { useSandboxQuery } from "../../../client/sandbox/useSandboxQuery";
import { queryClient } from "../../../lib/queryPersistence";

const t = useT();
// The reader's own interface language, so the built-in notice reads in the language the rest of the screen does.
const locale = computed(() => {
    const parsed = AiLiteracyLocaleSchema.safeParse(activeLocale.value);
    return parsed.success ? parsed.data : "en";
});
const statusQuery = rpcQuery("settings.aiLiteracy", () => ({ locale: locale.value }));
const { query } = useSandboxQuery(statusQuery);
const visible = computed({ get: () => query.data.value?.show === true && query.data.value.confirmedAt === undefined, set: () => {} });
const busy = ref(false);
const error = ref("");
const confirm = async (): Promise<void> => {
    const current = query.data.value;
    if (current === undefined || busy.value) {return;}
    busy.value = true;
    error.value = "";
    try {
        await sandboxRpc.settings.confirmAiLiteracy({ version: current.version, locale: locale.value });
        await queryClient.invalidateQueries({ queryKey: statusQuery.queryKey.value });
        await queryClient.invalidateQueries({ queryKey: rpcQuery("settings.aiLiteracyConfirmations").queryKey.value });
    } catch (cause) {
        error.value = errorMessage(cause);
    } finally {
        busy.value = false;
    }
};
</script>

<template>
    <Modal v-model:open="visible" :header="t(`sandbox.aiLiteracy.title`)" :description="t(`sandbox.aiLiteracy.description`)" :dismissable="false" size="md">
        <div class="flex flex-col gap-4">
            <p class="whitespace-pre-wrap text-sm leading-relaxed">{{ query.data.value?.text }}</p>
            <Notice v-if="error" tone="danger">{{ error }}</Notice>
            <div class="flex justify-end"><Button autofocus :label="t(`sandbox.aiLiteracy.confirm`)" :loading="busy" @click="confirm" /></div>
        </div>
    </Modal>
</template>
