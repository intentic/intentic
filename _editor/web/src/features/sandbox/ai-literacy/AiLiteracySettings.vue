<script setup lang="ts">
import { AI_LITERACY_TEXT, AiLiteracyLocaleSchema } from "@intentic/sandbox-contract";
import { Button, Notice, Row, RowNote, ui } from "@intentic/ui";
import { formatDateTime } from "@intentic/ui/format";
import { activeLocale, useT } from "@intentic/ui/i18n";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, ref, watch } from "vue";
import { rpcQuery } from "../../../client/sandbox/rpcQuery";
import { useSandboxQuery } from "../../../client/sandbox/useSandboxQuery";
import { useSandboxSettings } from "../overview/useSandboxSettings";

// The AI notice (art. 4 of the EU AI Act): whether people are shown it before they start, its words, and who confirmed
// which wording. Rows only, no group of its own: Sandbox ▸ Access sets them beside the product analytics switch, the
// other thing about the people using the box rather than about the agent.

const t = useT();
const { settings, patch, refusal, save } = useSandboxSettings();
const { query } = useSandboxQuery(rpcQuery(`settings.aiLiteracyConfirmations`));
const show = computed(() => settings.value?.aiNotice.show === true);
const draft = ref(``);
const locale = computed(() => {
    const parsed = AiLiteracyLocaleSchema.safeParse(activeLocale.value);
    return parsed.success ? parsed.data : `en`;
});
watch(
    () => settings.value?.aiNotice.text,
    (text) => {
        draft.value = text ?? ``;
    },
    { immediate: true },
);
const saveNotice = (): void => {
    if (settings.value !== undefined) {
        patch({ aiNotice: { ...settings.value.aiNotice, text: draft.value } });
    }
};
const toggle = (value: boolean): void => {
    if (settings.value !== undefined) {
        patch({ aiNotice: { ...settings.value.aiNotice, show: value } });
    }
};
</script>

<template>
    <Row icon="sparkles" :title="t(`sandbox.aiLiteracy.settingsTitle`)" :description="t(`sandbox.aiLiteracy.settingsDescription`)">
        <template #control>
            <ToggleSwitch :model-value="show" :disabled="!settings" :aria-label="t(`sandbox.aiLiteracy.settingsTitle`)" @update:model-value="toggle" />
        </template>
    </Row>
    <RowNote v-if="show" variant="block">
        <div class="flex flex-col gap-3">
            <label class="ui-field">
                <span class="ui-field-label">{{ t(`sandbox.aiLiteracy.customText`) }}</span>
                <textarea v-model="draft" rows="5" maxlength="4000" :class="ui.input()" class="w-full" :placeholder="t(`sandbox.aiLiteracy.customPlaceholder`)" />
            </label>
            <div class="flex justify-end"><Button :label="t(`sandbox.aiLiteracy.save`)" :loading="save.isPending.value" @click="saveNotice" /></div>
            <div>
                <p class="text-xs text-muted">{{ t(`sandbox.aiLiteracy.preview`) }}</p>
                <p class="whitespace-pre-wrap text-sm">{{ draft.trim() || AI_LITERACY_TEXT[locale] }}</p>
            </div>
            <div>
                <p class="text-xs text-muted">{{ t(`sandbox.aiLiteracy.confirmations`) }}</p>
                <ul v-if="query.data.value?.records.length" class="text-sm">
                    <li v-for="record in query.data.value.records" :key="`${record.member}:${record.version}`">
                        {{ record.member || t(`sandbox.aiLiteracy.localMember`) }} · {{ formatDateTime(Date.parse(record.confirmedAt)) }} · {{ record.version.slice(0, 12) }}
                    </li>
                </ul>
                <p v-else class="text-sm text-muted">{{ t(`sandbox.aiLiteracy.none`) }}</p>
            </div>
        </div>
    </RowNote>
    <RowNote v-if="refusal" variant="block"><Notice :of="refusal" /></RowNote>
</template>
