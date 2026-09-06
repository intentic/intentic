<script setup lang="ts">
import { MarkdownDocument, Notice, RowGroup, RowNote } from "@intentic/ui";
import { useSafetyPolicy } from "../../environment/useSafetyPolicy";
import { useDraft } from "../../../../lib/useDraft";
import SafetyPolicyInfo from "./SafetyPolicyInfo.vue";

/* THE SAFETY POLICY, AS A DOCUMENT. What used to be six pickers.
 *
 * WHY THE PICKERS WENT. They set a verdict per kind of command, and the verdict was reached by a regex over the
 * command text, so `echo "rm -rf /"` written into a README raised the same card as an actual recursive delete.
 * The page could not fix that, because the classifier could not tell them apart at any setting: deciding whether
 * a command is dangerous is an act of understanding, and it is now done by a model that reads this text (the
 * daemon's guard/command-gate.ts runs the pipeline; the contract's safety-policy.ts argues the design).
 *
 * So the control is a document, and that is the honest shape. What the owner is configuring is a judgment,
 * prose is what a judgment is written in, and the file it edits is markdown — so it is edited as the document
 * it is, on <MarkdownDocument>, the app's one markdown surface: headings set as headings, the markup only
 * visible on the line the caret is in, and no Preview pill because what is on screen already IS what the judge
 * will read. It also means the assistant can edit it when asked to — "stop asking me about force-pushes in
 * this repo" appends a line — which no arrangement of pickers could support.
 *
 * AN EXPLICIT SAVE, which the component takes as a declaration rather than this page arranging one. Every turn
 * that starts reads this file, so a half-typed sentence going live 700ms after it is typed is a hazard, not a
 * convenience; `save="explicit"` is how a document says so, and the Save button, the "not saved yet" line and
 * Ctrl-S all come with it. (useDraft still holds the seeding rule: follow another window's write, never over
 * an edit in progress here.)
 */

const { text, custom, save, isSaving, isLoading, error } = useSafetyPolicy();

const draft = useDraft(() => (isLoading.value ? undefined : text.value));
</script>

<template>
    <RowGroup label="Safety policy">
        <template #info><SafetyPolicyInfo /></template>

        <RowNote>
            What the assistant should stop and ask you about before it runs something. Written for a reader, not a parser: a model reads this and
            applies it to each command. You can ask the assistant to edit it too.
        </RowNote>

        <RowNote variant="block">
            <!-- The app's one markdown surface, in the frame this row gives it. The scroll belongs to the frame:
                 a policy that runs long stays inside the row rather than pushing the notice and the Save button
                 below it off the page. The measure is set here too, because how wide the words get is a fact
                 about this row and not about the document. -->
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

            <!-- The one thing on this page that is NOT up for discussion, stated where somebody editing the text
                 above will read it. Without this the document looks like the whole of the policy, and an owner
                 could delete every line of it believing they had switched the gate off. -->
            <Notice tone="info" class="mt-2 text-2xs">
                Whatever this says, wiping a block device, deleting <code>/</code>, or deleting anything under <code>/history</code> always asks — and
                on your own computers, so does any delete. Those rules are not written here and cannot be edited away, because nothing brings what
                they take back. They are listed in full under “What gets stopped” above.
            </Notice>

            <Notice v-if="error !== undefined" tone="danger" class="mt-2 text-2xs">{{ error }}</Notice>
        </RowNote>
    </RowGroup>
</template>
