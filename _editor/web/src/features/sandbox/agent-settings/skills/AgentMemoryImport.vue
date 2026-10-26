<script setup lang="ts">
import { Button, CopyButton, Icon, Notice, ProseField, Row, RowGroup, RowNote, ui } from "@intentic/ui";
import { ref } from "vue";
import { IMPORT_PROMPT } from "../../../extensions/memoryImport";
import { useAgentMemory } from "./useAgentMemory";
import { useT } from "@intentic/ui/i18n";

// Two steps, each a row of the list: copy a prompt out, paste its answer back in. The prompt is the thing to copy,
// not a thing to read, so it is one press away and folded behind "Show prompt" rather than a read-only monospace box
// that took a screenful to say "press Copy". The answer goes into a field that grows with what is pasted.

const t = useT();

const { importError, importText, importing, importMemory } = useAgentMemory();

const showPrompt = ref(false);
</script>

<template>
    <RowGroup data-setting="agent-memory-import" :label="t(`sandbox.agentMemory.bringMemoryOverAnother`)">
        <Row :title="t(`sandbox.agentMemory.copyPromptIntoChat`)">
            <template #lead>
                <span class="flex size-5 shrink-0 items-center justify-center rounded-full bg-content/10 text-2xs font-semibold text-muted">1</span>
            </template>
            <template #description>
                <button type="button" :class="ui.textButton({ tone: `subtle`, size: `xs`, flush: true })" :aria-expanded="showPrompt" @click="showPrompt = !showPrompt">
                    {{ showPrompt ? t(`sandbox.agentMemory.hidePrompt`) : t(`sandbox.agentMemory.showPrompt`) }}
                </button>
            </template>
            <template #control>
                <CopyButton cta :text="IMPORT_PROMPT" :label="t(`sandbox.agentMemory.copyPrompt`)" />
            </template>
            <template v-if="showPrompt" #below>
                <p class="whitespace-pre-wrap text-2xs leading-relaxed text-muted">{{ IMPORT_PROMPT }}</p>
            </template>
        </Row>

        <RowNote variant="block">
            <div class="flex flex-col gap-2">
                <label for="memory-import-answer" class="flex items-center gap-3 text-sm font-medium text-content">
                    <span class="flex size-5 shrink-0 items-center justify-center rounded-full bg-content/10 text-2xs font-semibold text-muted">2</span>
                    {{ t(`sandbox.agentMemory.pasteResultBelowTo`) }}
                </label>
                <Notice v-if="importError" :of="importError" />
                <div class="ui-field-shell max-h-80 overflow-y-auto px-1 py-0.5">
                    <ProseField
                        id="memory-import-answer"
                        v-model="importText"
                        :placeholder="t(`sandbox.agentMemory.pasteMemoryDetailsHere`)"
                        class="min-h-20"
                    />
                </div>
                <Button
                    class="self-end"
                    size="small"
                    :label="t(`sandbox.agentMemory.addToMemory`)"
                    :loading="importing"
                    :disabled="importText.trim().length === 0"
                    @click="importMemory"
                >
                    <template #icon><Icon name="sparkles" /></template>
                </Button>
            </div>
        </RowNote>
    </RowGroup>
</template>
