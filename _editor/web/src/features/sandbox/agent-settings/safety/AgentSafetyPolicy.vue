<script setup lang="ts">
import { MarkdownDocument, Notice, type NoticeModel, RowGroup, RowNote } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { computed } from "vue";
import { useSafetyPolicy } from "../../environment/useSafetyPolicy";
import { useDraft } from "../../../../lib/useDraft";
import { useT } from "@intentic/ui/i18n";

// Replaces six regex-verdict pickers, which couldn't tell a real `rm -rf /` from one quoted in a README; danger is now
// judged by a model reading this text (guard/command-guard.ts runs it, the contract's safety-policy.ts argues the
// design). Edited as markdown, so the assistant can edit it too, with an explicit save since every new turn reads this
// file live.

const t = useT();

const { text, custom, save, isSaving, saveError, isLoading, error } = useSafetyPolicy();

const draft = useDraft(() => (isLoading.value ? undefined : text.value));
// A refused save keeps the owner's text on screen as "Not saved yet"; said here, or the press reads as doing nothing.
const refused = computed<NoticeModel | undefined>(() =>
    saveError.value === null ? undefined : noticeFrom(saveError.value, t(`sandbox.agentSafetyPolicy.couldntSave`)),
);
</script>

<template>
    <RowGroup :label="t(`sandbox.agentSafetyPolicy.safetyPolicy`)">
        <!-- The group's card IS the page. Only the document scrolls, so a long policy never carries Save off the screen. -->
        <MarkdownDocument
            v-model="draft"
            frame="section"
            :editable="!isLoading"
            :stored="isLoading ? undefined : text"
            :saving="isSaving"
            save="explicit"
            :label="t(`sandbox.agentSafetyPolicy.safetyPolicy`)"
            :placeholder="isLoading ? t(`ui.status.loading`) : t(`sandbox.agentSafetyPolicy.whatAssistantShouldStop`)"
            @save="save"
        >
            <template #note>
                <template v-if="custom">{{ t(`sandbox.agentSafetyPolicy.ownTextIn`) }} <code>.intentic/config/safety.md</code>.</template>
                <template v-else>{{ t(`sandbox.agentSafetyPolicy.textProductShipsDescribes`) }}</template>
            </template>
        </MarkdownDocument>

        <RowNote v-if="error !== undefined" variant="block"
            ><Notice tone="danger" class="text-2xs">{{ error }}</Notice></RowNote
        >
        <RowNote v-if="refused !== undefined" variant="block"><Notice :of="refused" /></RowNote>
    </RowGroup>
</template>
