<script setup lang="ts">
import { Button, CopyButton, Notice, RowGroup, RowNote, ui } from "@intentic/ui";
import { IMPORT_PROMPT } from "../../../extensions/memoryImport";
import { useAgentMemory } from "./useAgentMemory";
import { useT } from "@intentic/ui/i18n";

const t = useT();

const { importError, importText, importing, importMemory } = useAgentMemory();
</script>

<template>
    <RowGroup :label="t(`sandbox.agentMemory.bringMemoryOverAnother`)">
        <RowNote variant="block">
            <Notice v-if="importError" :of="importError" />

            <div class="flex flex-col gap-3">
                <label class="flex flex-col gap-1.5">
                    <span class="flex items-center gap-2 text-xs text-subtle">
                        <span class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-content/10 text-2xs font-semibold">1</span>
                        {{ t(`sandbox.agentMemory.copyPromptIntoChat`) }}
                    </span>
                    <textarea :value="IMPORT_PROMPT" readonly rows="6" :class="ui.input('w-full font-mono resize-y text-subtle')"></textarea>
                    <CopyButton class="self-end" :text="IMPORT_PROMPT" :label="t(`sandbox.agentMemory.copyPrompt`)" />
                </label>

                <label class="flex flex-col gap-1.5">
                    <span class="flex items-center gap-2 text-xs text-subtle">
                        <span class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-content/10 text-2xs font-semibold">2</span>
                        {{ t(`sandbox.agentMemory.pasteResultBelowTo`) }}
                    </span>
                    <textarea
                        v-model="importText"
                        rows="8"
                        :placeholder="t(`sandbox.agentMemory.pasteMemoryDetailsHere`)"
                        :class="ui.input('w-full font-mono resize-y')"
                    ></textarea>
                    <Button
                        class="self-end"
                        :label="t(`sandbox.agentMemory.addToMemory`)"
                        :loading="importing"
                        :disabled="importText.trim().length === 0"
                        @click="importMemory"
                    >
                        <template #icon><Icon name="sparkles" /></template>
                    </Button>
                </label>
            </div>
        </RowNote>
    </RowGroup>
</template>
