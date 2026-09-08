<script setup lang="ts">
import { MEMORY_FILE } from "@intentic/constants";
import { Button, Card, CopyButton, MarkdownDocument, Notice, type NoticeModel, Row, ui } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { onMounted, ref } from "vue";
import { IMPORT_PROMPT, mergeMemory } from "../../../extensions/memoryImport";
import { useSandbox } from "../../client/useSandbox";
import { useWorkspaceTree } from "../../../workspace/explorer/useWorkspaceTree";

// One file, read at the top of every turn on every runtime; this card can read, edit and delete it, not just append
// via import. Save is explicit since a half-typed sentence going live would be read on the next turn.

const sandbox = useSandbox();
const { readFile, saveText } = useWorkspaceTree();

const draft = ref(``);
// The file's last-read/written content; draft is compared against it for unsaved state.
const onDisk = ref<string | undefined>(undefined);
const saving = ref(false);
const error = ref<NoticeModel | undefined>(undefined);

// A missing file reads as empty, not a failure; it is created on first save.
const load = async (): Promise<void> => {
    error.value = undefined;
    onDisk.value = undefined;
    try {
        const text = (await readFile(MEMORY_FILE)) ?? ``;
        onDisk.value = text;
        draft.value = text;
    } catch (caught) {
        error.value = noticeFrom(caught, `Couldn't read ${MEMORY_FILE}.`);
    }
};

const commit = async (text: string): Promise<void> => {
    saving.value = true;
    error.value = undefined;
    try {
        await saveText(MEMORY_FILE, text);
        onDisk.value = text;
    } catch (caught) {
        error.value = noticeFrom(caught, `Couldn't save ${MEMORY_FILE}.`);
    } finally {
        saving.value = false;
    }
};

onMounted(() => void load());

// Merges rather than overwrites; memoryImport.ts holds the fence markers.
const importText = ref(``);
const importing = ref(false);

const importMemory = async (): Promise<void> => {
    const text = importText.value.trim();
    if (text === `` || importing.value) {
        return;
    }
    importing.value = true;
    error.value = undefined;
    try {
        // Missing file starts as empty rather than failing (first import).
        const current = (await readFile(MEMORY_FILE)) ?? ``;
        await saveText(MEMORY_FILE, mergeMemory(current, text));
        importText.value = ``;
        // Reloads: the visible document is the file just written.
        await load();
    } catch (caught) {
        error.value = noticeFrom(caught, `Couldn't save memory.`);
    } finally {
        importing.value = false;
    }
};
</script>

<template>
    <Card class="flex flex-col gap-3">
        <Row flush :heading="2" icon="sparkles" title="Memory">
            <template #description>
                The standing instructions
                <span class="font-medium text-content">{{ sandbox.active.value?.name ?? `your sandbox` }}</span> carries into every turn, on whichever
                model runs it. <code>{{ MEMORY_FILE }}</code> at the workspace root; a folder deeper in can carry its own, read on top of this one by a
                conversation that starts there.
            </template>
        </Row>

        <Notice v-if="error" :of="error" />

        <div class="ui-field-shell max-h-[60dvh] overflow-auto p-3" style="--prose-measure: 72ch">
            <MarkdownDocument
                v-model="draft"
                :editable="onDisk !== undefined"
                :stored="onDisk"
                :saving="saving"
                save="explicit"
                :label="MEMORY_FILE"
                :placeholder="onDisk === undefined ? `Reading ${MEMORY_FILE}…` : `Nothing here yet. What every turn in this workspace should know.`"
                class="min-h-48"
                @save="commit"
            >
                <template #note><code>{{ MEMORY_FILE }}</code>, at the workspace root.</template>
            </MarkdownDocument>
        </div>

        <!-- Import sits under the document; editing is the primary path, this is the narrow one. -->
        <div class="flex flex-col gap-3 border-t border-line/60 pt-3">
            <span class="text-sm font-medium text-content">Bring memory over from another assistant</span>

            <label class="flex flex-col gap-1.5">
                <span class="flex items-center gap-2 text-xs text-subtle">
                    <span class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-content/10 text-2xs font-semibold">1</span>
                    Copy this prompt into a chat with your other AI provider
                </span>
                <textarea :value="IMPORT_PROMPT" readonly rows="6" :class="ui.input('w-full font-mono resize-y text-subtle')"></textarea>
                <div class="flex justify-end">
                    <CopyButton :text="IMPORT_PROMPT" label="Copy prompt" />
                </div>
            </label>

            <label class="flex flex-col gap-1.5">
                <span class="flex items-center gap-2 text-xs text-subtle">
                    <span class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-content/10 text-2xs font-semibold">2</span>
                    Paste the result below to merge it into both files
                </span>
                <textarea
                    v-model="importText"
                    rows="8"
                    placeholder="Paste your memory details here"
                    :class="ui.input('w-full font-mono resize-y')"
                ></textarea>
                <div class="flex justify-end">
                    <Button label="Add to memory" :loading="importing" :disabled="importText.trim().length === 0" @click="importMemory">
                        <template #icon><Icon name="sparkles" /></template>
                    </Button>
                </div>
            </label>
        </div>
    </Card>
</template>
