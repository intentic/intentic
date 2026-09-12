<script setup lang="ts">
import { MarkdownDocument, Notice, RowGroup, RowNote } from "@intentic/ui";
import { useSafetyPolicy } from "../../environment/useSafetyPolicy";
import { useDraft } from "../../../../lib/useDraft";
import SafetyPolicyInfo from "./SafetyPolicyInfo.vue";

// Replaces six regex-verdict pickers, which couldn't tell a real `rm -rf /` from one quoted in a README; danger is now
// judged by a model reading this text (guard/command-gate.ts runs it, the contract's safety-policy.ts argues the
// design). Edited as markdown, so the assistant can edit it too, with an explicit save since every new turn reads this
// file live.

const { text, custom, save, isSaving, isLoading, error } = useSafetyPolicy();

const draft = useDraft(() => (isLoading.value ? undefined : text.value));
</script>

<template>
    <RowGroup label="Safety policy">
        <template #info><SafetyPolicyInfo /></template>

        <RowNote variant="block">
            <!--
                The frame owns the scroll, so a long policy stays inside the row rather than pushing the Save button off the page; the prose measure
                is set here too, since it's a fact about this row, not the document.
            -->
            <div class="ui-field-shell max-h-[60dvh] overflow-auto p-3" style="--prose-measure: 72ch">
                <MarkdownDocument
                    v-model="draft"
                    :editable="!isLoading"
                    :stored="isLoading ? undefined : text"
                    :saving="isSaving"
                    save="explicit"
                    label="Safety policy"
                    :placeholder="isLoading ? `Loading…` : `What the assistant should stop and ask you about.`"
                    class="min-h-64"
                    @save="save"
                >
                    <template #note>
                        <template v-if="custom">Your own text, in <code>.intentic/config/safety.md</code>.</template>
                        <template v-else>The text this product ships with. It describes what a fresh sandbox already does.</template>
                    </template>
                </MarkdownDocument>
            </div>

            <Notice v-if="error !== undefined" tone="danger" class="mt-2 text-2xs">{{ error }}</Notice>
        </RowNote>
    </RowGroup>
</template>
