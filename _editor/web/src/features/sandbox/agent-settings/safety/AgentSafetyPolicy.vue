<script setup lang="ts">
import { MarkdownDocument, Notice, RowGroup, RowNote } from "@intentic/ui";
import { useSafetyPolicy } from "../../environment/useSafetyPolicy";
import { useDraft } from "../../../../lib/useDraft";
import { useT } from "@intentic/ui/i18n";

// Replaces six regex-verdict pickers, which couldn't tell a real `rm -rf /` from one quoted in a README; danger is now
// judged by a model reading this text (guard/command-gate.ts runs it, the contract's safety-policy.ts argues the
// design). Edited as markdown, so the assistant can edit it too, with an explicit save since every new turn reads this
// file live.

const t = useT();

const { text, custom, save, isSaving, isLoading, error } = useSafetyPolicy();

const draft = useDraft(() => (isLoading.value ? undefined : text.value));
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
            :placeholder="isLoading ? t(`sandbox.agentSafetyPolicy.loading`) : t(`sandbox.agentSafetyPolicy.whatAssistantShouldStop`)"
            @save="save"
        >
            <template #note>
                <template v-if="custom">{{ t(`sandbox.agentSafetyPolicy.ownTextIn`) }} <code>.intentic/config/safety.md</code>.</template>
                <template v-else>{{ t(`sandbox.agentSafetyPolicy.textProductShipsDescribes`) }}</template>
            </template>
        </MarkdownDocument>

        <RowNote v-if="error !== undefined" variant="block"><Notice tone="danger" class="text-2xs">{{ error }}</Notice></RowNote>
    </RowGroup>
</template>
