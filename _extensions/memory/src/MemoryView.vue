<script setup lang="ts">
import type { MemoryFileEntry } from "@intentic/sandbox-contract";
import { cmp, formatBytes, Icon, InfoHint, Page, PageHeader, timeAgo } from "@intentic/extension-ui";
import { computed, ref, watch } from "vue";
import { useMemory, useMemoryFile, useMemoryMutations } from "./useMemory";

/* The memory extension: what the agent remembers across sessions — the MEMORY.md index plus one markdown note
 * per fact, per project. Read to review, edit to correct a stale fact, delete to make it forget. */

const { files, error, isLoading } = useMemory();

const selected = ref<{ project: string; name: string }>();
const { note, error: noteError, isLoading: noteLoading } = useMemoryFile(selected);
const { save, remove } = useMemoryMutations();

// One section per project, MEMORY.md (the index the agent loads every session) pinned first, the rest kept in
// the list's newest-first order. Projects sort by their newest note so the active one leads.
const projects = computed(() => {
    const byProject = new Map<string, MemoryFileEntry[]>();
    for (const file of files.value) {
        byProject.set(file.project, [...(byProject.get(file.project) ?? []), file]);
    }
    return [...byProject.entries()].map(([project, entries]) => ({
        project,
        entries: entries.toSorted((a, b) => Number(b.name === `MEMORY.md`) - Number(a.name === `MEMORY.md`)),
    }));
});

// The note's frontmatter, for the header chips; the body renders without it (the raw editor keeps it).
const parsed = computed(() => {
    const content = note.value?.content ?? ``;
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
    if (match === null) {
        return { description: undefined, type: undefined, body: content };
    }
    const field = (name: string): string | undefined =>
        new RegExp(`^\\s*${name}:\\s*(.+)$`, `m`).exec(match[1]!)?.[1]?.replace(/^"(.*)"$/, `$1`);
    return { description: field(`description`), type: field(`type`), body: content.slice(match[0].length) };
});

// Edit mode holds the RAW file (frontmatter included) so a save round-trips byte-identical apart from the edit.
const editing = ref(false);
const draft = ref(``);
const startEdit = (): void => {
    draft.value = note.value?.content ?? ``;
    editing.value = true;
};
const saveDraft = async (): Promise<void> => {
    if (selected.value === undefined) {
        return;
    }
    await save.mutateAsync({ ...selected.value, content: draft.value });
    editing.value = false;
};

// Two-click delete: the first click arms, the second deletes — enough friction without a dialog.
const armedDelete = ref(false);
const deleteNote = async (): Promise<void> => {
    if (selected.value === undefined) {
        return;
    }
    await remove.mutateAsync(selected.value);
    selected.value = undefined;
};
watch(selected, () => {
    editing.value = false;
    armedDelete.value = false;
});

const mutationError = computed(() => save.error.value?.message ?? remove.error.value?.message);
</script>

<template>
    <div class="h-full min-h-0 overflow-auto">
        <Page width="wide">
            <PageHeader title="Memory" description="What the agent remembers across sessions — reviewable, editable, forgettable.">
                <template #info>
                    <InfoHint label="Memory">
                        <span class="block text-sm font-medium text-content">Agent memory</span>
                        <span class="mt-1 block text-xs text-muted">
                            The agent keeps a persistent memory per project: <b>MEMORY.md</b> — the index it loads at the start of every session —
                            plus one markdown note per fact (who you are, feedback it was given, project context, references). Edit a note to
                            correct it, or delete it to make the agent forget.
                        </span>
                    </InfoHint>
                </template>
            </PageHeader>

            <div v-if="error" :class="cmp.alertDanger('mb-4 px-4 py-3 text-sm')">{{ error }}</div>

            <div class="flex min-h-0 flex-col gap-4">
                <section class="rounded-lg border border-line bg-card p-4">
                    <h3 :class="cmp.sectionLabel('mb-3')">Notes</h3>
                    <div v-if="files.length > 0">
                        <div v-for="group in projects" :key="group.project" class="mb-2">
                            <p class="mb-1 font-mono text-2xs uppercase text-subtle/70">{{ group.project }}</p>
                            <div class="flex flex-col divide-y divide-line">
                                <button
                                    v-for="file in group.entries"
                                    :key="`${file.project}/${file.name}`"
                                    type="button"
                                    class="flex items-center gap-3 py-1.5 text-left hover:bg-hover"
                                    :class="selected?.project === file.project && selected?.name === file.name ? `text-content` : `text-muted`"
                                    @click="selected = { project: file.project, name: file.name }"
                                >
                                    <Icon
                                        :name="file.name === `MEMORY.md` ? `sparkles` : `file`"
                                        class="text-xs"
                                        :class="selected?.project === file.project && selected?.name === file.name ? `text-link` : `text-subtle`"
                                    />
                                    <span class="min-w-0 flex-1 truncate font-mono text-xs" :title="file.name">{{ file.name }}</span>
                                    <span class="shrink-0 text-2xs text-subtle">{{ formatBytes(file.sizeBytes) }}</span>
                                    <span class="shrink-0 text-2xs text-subtle" :title="new Date(file.modifiedAt).toLocaleString()">
                                        {{ timeAgo(file.modifiedAt) }}
                                    </span>
                                </button>
                            </div>
                        </div>
                    </div>
                    <p v-else-if="!isLoading" class="py-6 text-center text-sm text-muted">
                        Nothing remembered yet. Notes appear as the agent saves memories while working.
                    </p>
                </section>

                <section v-if="selected" class="rounded-lg border border-line bg-card p-4">
                    <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
                        <div class="flex min-w-0 items-center gap-2">
                            <h3 class="min-w-0 truncate font-mono text-xs text-content">{{ selected.name }}</h3>
                            <span v-if="parsed.type" class="shrink-0 rounded border border-line px-1.5 text-2xs uppercase text-subtle">
                                {{ parsed.type }}
                            </span>
                        </div>
                        <div class="flex items-center gap-2">
                            <template v-if="editing">
                                <button type="button" :class="cmp.buttonPrimary(`h-7 px-3 text-xs`)" :disabled="save.isPending.value" @click="saveDraft">
                                    {{ save.isPending.value ? `Saving…` : `Save` }}
                                </button>
                                <button type="button" :class="cmp.input(`h-7 px-3 text-xs`)" @click="editing = false">Cancel</button>
                            </template>
                            <template v-else>
                                <button type="button" :class="cmp.input(`h-7 px-3 text-xs`)" @click="startEdit">Edit</button>
                                <button
                                    type="button"
                                    :class="cmp.buttonDanger(`h-7 px-3 text-xs`)"
                                    :disabled="remove.isPending.value"
                                    @click="armedDelete ? deleteNote() : (armedDelete = true)"
                                >
                                    {{ armedDelete ? `Forget it — sure?` : `Forget` }}
                                </button>
                            </template>
                        </div>
                    </div>
                    <div v-if="noteError" :class="cmp.alertDanger('mb-2')">{{ noteError }}</div>
                    <div v-if="mutationError" :class="cmp.alertDanger('mb-2')">{{ mutationError }}</div>
                    <textarea
                        v-if="editing"
                        v-model="draft"
                        spellcheck="false"
                        :class="cmp.input(`h-80 w-full resize-y p-2 font-mono text-xs`)"
                    ></textarea>
                    <template v-else>
                        <p v-if="parsed.description" class="mb-2 text-xs italic text-muted">{{ parsed.description }}</p>
                        <pre class="max-h-128 overflow-auto whitespace-pre-wrap text-xs text-content">{{
                            parsed.body || (noteLoading ? `Loading…` : ``)
                        }}</pre>
                    </template>
                </section>
            </div>
        </Page>
    </div>
</template>
