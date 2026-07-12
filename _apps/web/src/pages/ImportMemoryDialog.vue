<script setup lang="ts">
import { cmp, CopyButton } from "@intentic-app/ui";
import Button from "primevue/button";
import Dialog from "primevue/dialog";
import { ref, watch } from "vue";
import { IMPORT_PROMPT, MEMORY_FILES, mergeMemory } from "../composables/extensions/memoryImport";
import { useSandbox } from "../composables/useSandbox";
import { useWorkspaceTree } from "../composables/workspace/useWorkspaceTree";

/* Import memory from another AI provider: the user runs IMPORT_PROMPT in their old assistant and pastes the
 * export back; "Add to memory" merges it into the active sandbox's per-agent memory files (CLAUDE.md +
 * AGENTS.md) via the shared workspace file I/O. Both steps are shown at once — it's a two-field form, not a
 * wizard. Opened from Settings. */

const visible = defineModel<boolean>(`visible`, { default: false });

const { active } = useSandbox();
const { readFile, saveText } = useWorkspaceTree();

const pasted = ref(``);
const saving = ref(false);
const error = ref<string | undefined>(undefined);

watch(visible, (open) => {
    if (open) {
        pasted.value = ``;
        error.value = undefined;
    }
});

const add = async (): Promise<void> => {
    const text = pasted.value.trim();
    if (text === `` || saving.value) {
        return;
    }
    saving.value = true;
    error.value = undefined;
    try {
        for (const file of MEMORY_FILES) {
            // readFile throws on a missing file (first import) — treat that as an empty starting point.
            const current = await readFile(file).catch(() => ``);
            await saveText(file, mergeMemory(current, text));
        }
        pasted.value = ``;
        visible.value = false;
    } catch (caught) {
        error.value = caught instanceof Error ? caught.message : `Couldn't save memory.`;
    } finally {
        saving.value = false;
    }
};
</script>

<template>
    <Dialog v-model:visible="visible" :modal="true" :draggable="false" :dismissable-mask="true" :style="{ width: '34rem' }" header="Import memory">
        <p class="mb-4 text-sm text-muted">
            Bring context from another AI assistant into this workspace. Added to
            <span class="font-medium text-content">{{ active?.name ?? `your sandbox` }}</span
            >'s memory, so both Claude and ChatGPT remember it.
        </p>

        <div v-if="error" :class="cmp.alertDanger('mb-3')">{{ error }}</div>

        <div class="flex flex-col gap-4">
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
                    v-model="pasted"
                    rows="8"
                    placeholder="Paste your memory details here"
                    :class="cmp.input('w-full font-mono resize-y')"
                ></textarea>
            </label>
        </div>

        <template #footer>
            <Button label="Cancel" severity="secondary" :text="true" :disabled="saving" @click="visible = false" />
            <Button label="Add to memory" :loading="saving" :disabled="pasted.trim().length === 0" @click="add">
                <template #icon><Icon name="sparkles" /></template>
            </Button>
        </template>
    </Dialog>
</template>
