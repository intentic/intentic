<script setup lang="ts">
import { Button, Card, CopyButton, MarkdownDocument, Notice, type NoticeModel, Row, SegmentedControl, ui } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { onMounted, ref, watch } from "vue";
import { IMPORT_PROMPT, MEMORY_FILES, mergeMemory } from "../../../extensions/memoryImport";
import { useSandbox } from "../../client/useSandbox";
import { useWorkspaceTree } from "../../../workspace/explorer/useWorkspaceTree";

// CLAUDE.md and AGENTS.md are read at the top of every turn; this card can read, edit and delete them, not just
// append via import. Shows one file at a time, picked by name; save is explicit since a half-typed sentence going
// live would be read on the next turn.

const sandbox = useSandbox();
const { readFile, saveText } = useWorkspaceTree();

const FILES = MEMORY_FILES.map((name) => ({ label: name, value: name }));
const picked = ref<string>(MEMORY_FILES[0]);

const draft = ref(``);
// The file's last-read/written content; draft is compared against it for unsaved state.
const onDisk = ref<string | undefined>(undefined);
const saving = ref(false);
const error = ref<NoticeModel | undefined>(undefined);

// A missing file reads as empty, not a failure; both files are created on first save.
const load = async (name: string): Promise<void> => {
    error.value = undefined;
    onDisk.value = undefined;
    try {
        const text = (await readFile(name)) ?? ``;
        onDisk.value = text;
        draft.value = text;
    } catch (caught) {
        error.value = noticeFrom(caught, `Couldn't read ${name}.`);
    }
};

const commit = async (text: string): Promise<void> => {
    saving.value = true;
    error.value = undefined;
    try {
        await saveText(picked.value, text);
        onDisk.value = text;
    } catch (caught) {
        error.value = noticeFrom(caught, `Couldn't save ${picked.value}.`);
    } finally {
        saving.value = false;
    }
};

onMounted(() => void load(picked.value));
watch(picked, (name) => void load(name));

// Writes both files and merges rather than overwrites; memoryImport.ts holds the fence markers.
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
        for (const file of MEMORY_FILES) {
            // Missing file starts as empty rather than failing (first import).
            const current = (await readFile(file)) ?? ``;
            await saveText(file, mergeMemory(current, text));
        }
        importText.value = ``;
        // Reloads since the visible document may be one of the files just written.
        await load(picked.value);
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
                <span class="font-medium text-content">{{ sandbox.active.value?.name ?? `your sandbox` }}</span> carries into every turn.
                <code>CLAUDE.md</code> is what Claude reads and <code>AGENTS.md</code> is what Codex and ChatGPT read; both sit at the workspace root.
            </template>
            <template #control>
                <SegmentedControl v-model="picked" :options="FILES" aria-label="Which memory file" />
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
                :label="picked"
                :placeholder="onDisk === undefined ? `Reading ${picked}…` : `Nothing here yet. What every turn in this workspace should know.`"
                class="min-h-48"
                @save="commit"
            >
                <template #note><code>{{ picked }}</code>, at the workspace root.</template>
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
