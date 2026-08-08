<script setup lang="ts">
import { Card, cmp, CopyButton } from "@intentic/ui";
import Button from "primevue/button";
import { ref } from "vue";
import { IMPORT_PROMPT, MEMORY_FILES, mergeMemory } from "../../../composables/extensions/memoryImport";
import { useSandbox } from "../../../composables/sandbox/useSandbox";
import { errorMessage } from "../../../composables/useAsyncAction";
import { useWorkspaceTree } from "../../../composables/workspace/useWorkspaceTree";

/* Bring context from another AI assistant into this sandbox's agent memory files. A two-step copy-paste rather
 * than a setting, which is why it keeps its own card instead of joining a RowGroup: the work happens in another
 * app's chat window, and the two textareas are the whole surface. */

const sandbox = useSandbox();
const { readFile, saveText } = useWorkspaceTree();
const importText = ref(``);
const importSaving = ref(false);
const importError = ref<string | undefined>(undefined);
const importMemory = async (): Promise<void> => {
    const text = importText.value.trim();
    if (text === `` || importSaving.value) {
        return;
    }
    importSaving.value = true;
    importError.value = undefined;
    try {
        for (const file of MEMORY_FILES) {
            // No file yet is the first import, which starts from empty rather than failing.
            const current = (await readFile(file)) ?? ``;
            await saveText(file, mergeMemory(current, text));
        }
        importText.value = ``;
    } catch (caught) {
        importError.value = errorMessage(caught, `Couldn't save memory.`);
    } finally {
        importSaving.value = false;
    }
};
</script>

<template>
    <Card class="flex flex-col gap-3">
        <div class="flex items-center gap-2.5">
            <Icon name="sparkles" class="text-lg text-muted" />
            <div>
                <h2 class="font-semibold leading-tight">Import memory</h2>
                <p class="text-xs text-muted">
                    Bring context from another AI assistant into
                    <span class="font-medium text-content">{{ sandbox.active.value?.name ?? `your sandbox` }}</span> so Claude and ChatGPT remember
                    it.
                </p>
            </div>
        </div>

        <div v-if="importError" :class="cmp.alertDanger()">{{ importError }}</div>

        <label class="flex flex-col gap-1.5">
            <span class="flex items-center gap-2 text-sm font-medium text-content">
                <span class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-content/10 text-2xs font-semibold">1</span>
                Copy this prompt into a chat with your other AI provider
            </span>
            <textarea :value="IMPORT_PROMPT" readonly rows="6" :class="cmp.input('w-full font-mono resize-y text-subtle')"></textarea>
            <div class="flex justify-end">
                <CopyButton :text="IMPORT_PROMPT" label="Copy prompt" />
            </div>
        </label>

        <label class="flex flex-col gap-1.5">
            <span class="flex items-center gap-2 text-sm font-medium text-content">
                <span class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-content/10 text-2xs font-semibold">2</span>
                Paste the result below to add it to memory
            </span>
            <textarea
                v-model="importText"
                rows="8"
                placeholder="Paste your memory details here"
                :class="cmp.input('w-full font-mono resize-y')"
            ></textarea>
            <div class="flex justify-end">
                <Button label="Add to memory" :loading="importSaving" :disabled="importText.trim().length === 0" @click="importMemory">
                    <template #icon><Icon name="sparkles" /></template>
                </Button>
            </div>
        </label>
    </Card>
</template>
