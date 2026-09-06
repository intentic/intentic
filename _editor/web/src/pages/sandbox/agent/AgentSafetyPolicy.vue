<script setup lang="ts">
import { Button, CodeField, Notice, RowGroup, RowNote } from "@intentic/ui";
import { computed } from "vue";
import { useSafetyPolicy } from "../../../composables/sandbox/useSafetyPolicy";
import { useDraft } from "../../../composables/useDraft";
import SafetyPolicyInfo from "./SafetyPolicyInfo.vue";

/* THE SAFETY POLICY, AS A DOCUMENT. What used to be six pickers.
 *
 * WHY THE PICKERS WENT. They set a verdict per kind of command, and the verdict was reached by a regex over the
 * command text, so `echo "rm -rf /"` written into a README raised the same card as an actual recursive delete.
 * The page could not fix that, because the classifier could not tell them apart at any setting: deciding whether
 * a command is dangerous is an act of understanding, and it is now done by a model that reads this text (the
 * daemon's guard/command-gate.ts runs the pipeline; the contract's safety-policy.ts argues the design).
 *
 * So the control is a document surface (<CodeField>, markdown), and that is the honest shape. What the owner is
 * configuring is a judgment, prose is what a judgment is written in, and the file it edits is markdown — so it
 * is edited where its headings and lists are coloured, on the same surface the skills and the memory notes use,
 * rather than in a grey box of a fixed sixteen rows. It also means the assistant can edit it when asked to —
 * "stop asking me about force-pushes in this repo" appends a line — which no arrangement of pickers could
 * support.
 *
 * A DRAFT WITH AN EXPLICIT SAVE, not a per-keystroke write: this is long text somebody is composing, and every
 * turn that starts reads it. Committed on blur or from the button, the same shape as the custom system prompt
 * next door and for the same reasons (useDraft holds the seeding rule).
 */

const { text, custom, save, isSaving, isLoading, error } = useSafetyPolicy();

const draft = useDraft(() => (isLoading.value ? undefined : text.value));
const dirty = computed(() => !isLoading.value && draft.value !== text.value);

const commit = (): void => {
    if (dirty.value) {
        save(draft.value);
    }
};
</script>

<template>
    <RowGroup label="Safety policy">
        <template #info><SafetyPolicyInfo /></template>

        <RowNote>
            What the assistant should stop and ask you about before it runs something. Written for a reader, not a parser: a model reads this and
            applies it to each command. You can ask the assistant to edit it too.
        </RowNote>

        <RowNote variant="block">
            <!-- The same source surface the skills and the memory notes are written on: markdown's own colours
                 under a real caret, growing with the document instead of showing it through a sixteen-line
                 window. The frame is the caller's (<CodeField> is a bare sheet by contract), and the scroll
                 belongs to it: a policy that runs long stays inside the row rather than pushing the Save button
                 and the notice below it off the page. -->
            <div class="ui-field-shell max-h-[60dvh] overflow-auto p-2">
                <CodeField
                    v-model="draft"
                    lang="markdown"
                    :readonly="isLoading"
                    :placeholder="isLoading ? `Loading…` : `What the assistant should stop and ask you about.`"
                    aria-label="Safety policy"
                    class="min-h-64"
                    @change="commit"
                />
            </div>

            <!-- The one thing on this page that is NOT up for discussion, stated where somebody editing the text
                 above will read it. Without this the document looks like the whole of the policy, and an owner
                 could delete every line of it believing they had switched the gate off. -->
            <Notice tone="info" class="mt-2 text-2xs">
                Whatever this says, wiping a block device, deleting <code>/</code>, or deleting anything under <code>/history</code> always asks — and
                on your own computers, so does any delete. Those rules are not written here and cannot be edited away, because nothing brings what
                they take back. They are listed in full under “What gets stopped” above.
            </Notice>

            <Notice v-if="error !== undefined" tone="danger" class="mt-2 text-2xs">{{ error }}</Notice>

            <div class="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                <span class="text-2xs text-content/60">
                    <template v-if="custom">Your own text, in <code>.intentic/config/safety.md</code>.</template>
                    <template v-else>The text this product ships with. It describes what a fresh sandbox already does.</template>
                </span>
                <Button size="sm" :disabled="!dirty || isSaving" @click="commit">{{ isSaving ? `Saving…` : `Save` }}</Button>
            </div>
        </RowNote>
    </RowGroup>
</template>
