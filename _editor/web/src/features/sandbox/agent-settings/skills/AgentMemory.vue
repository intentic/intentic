<script setup lang="ts">
import { Button, Card, CopyButton, MarkdownDocument, Notice, type NoticeModel, Row, SegmentedControl, ui } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { onMounted, ref, watch } from "vue";
import { IMPORT_PROMPT, MEMORY_FILES, mergeMemory } from "../../../extensions/memoryImport";
import { useSandbox } from "../../client/useSandbox";
import { useWorkspaceTree } from "../../../workspace/explorer/useWorkspaceTree";

/* THE TWO MEMORY FILES, AND THE ONE PLACE THEY COULD NOT BE EDITED.
 *
 * `CLAUDE.md` and `AGENTS.md` are read at the top of every turn — they are the standing instructions this
 * workspace carries — and this card was the only surface in the app that touched them. It could only APPEND:
 * paste an export from another assistant and it merged a fenced block in. Everything else you might want to do
 * to your own standing instructions (read them, fix a line, delete a paragraph that stopped being true) had to
 * happen by finding the file in the workspace tree and knowing that was where it lived.
 *
 * So the files are here, on the same surface every other markdown config in the app is written on, and the
 * import is what it always was: a second, narrower way in, kept because the work happens in another app's chat
 * window and pasting an export is not editing.
 *
 * ONE DOCUMENT AT A TIME, picked by name. The two files hold the same content for two different readers, and
 * showing both at once would be two long documents down one card with no way to tell at a glance which is
 * which. `save="explicit"` for the reason the system prompt has it: every turn reads this, and a half-typed
 * sentence going live seven hundred milliseconds after it is typed is not a convenience.
 */

const sandbox = useSandbox();
const { readFile, saveText } = useWorkspaceTree();

const FILES = MEMORY_FILES.map((name) => ({ label: name, value: name }));
const picked = ref<string>(MEMORY_FILES[0]);

const draft = ref(``);
// What the file said when it was last read or written: what the document measures "unsaved" against.
const onDisk = ref<string | undefined>(undefined);
const saving = ref(false);
const error = ref<NoticeModel | undefined>(undefined);

// A file nobody has written yet reads as empty rather than as a failure: these two are created on first save,
// and a fresh workspace has neither.
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

/* ── Bringing memory in from another assistant ───────────────────────────────────────────────────────────────
 *
 * A two-step copy-paste rather than a setting, which is why it keeps its own block: the work happens in another
 * app's chat window, and the paste box is the whole surface. It writes BOTH files, because the block is the
 * same context for two readers, and it merges rather than overwrites (memoryImport.ts holds the fences). */
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
            // No file yet is the first import, which starts from empty rather than failing.
            const current = (await readFile(file)) ?? ``;
            await saveText(file, mergeMemory(current, text));
        }
        importText.value = ``;
        // The document on screen is one of the two files just written, so it has to say so.
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

        <!-- THE IMPORT, under the document rather than instead of it: it is the narrow path (bring a block over
             from another assistant) and editing is the wide one. It was the whole of this card until the files
             themselves could be opened here. -->
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
