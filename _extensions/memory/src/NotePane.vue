<script setup lang="ts">
import type { MemoryFileEntry } from "@intentic/sandbox-contract";
import { Button, Code, CopyButton, formatBytes, Icon, Markdown, Segmented, StatusBadge, type StatusVariant } from "@intentic/extension-ui";
import { computed, ref, watch } from "vue";
import { INDEX_NAME, linkifyNoteRefs, noteTitle, parseNote } from "./memoryNote";
import { freshness } from "./noteTime";
import { useMemoryFile, useMemoryMutations } from "./useMemory";

/* One memory note, read and curated: the agent's own words rendered as prose, the raw file behind a Source
 * toggle, and the two edits an owner ever wants to make — correct a fact, or make the agent forget it.
 *
 * Reading is the default and gets the whole pane; the controls sit in one header row above it. The three
 * states (read / edit / confirm-forget) are mutually exclusive on purpose — an editor open over a note that is
 * half-deleted is a way to lose work, not a feature. */

const { project, name, entry } = defineProps<{
    project: string;
    name: string;
    // The list row this note came from — its size and mtime are already known, so the header needs no fetch.
    entry: MemoryFileEntry | undefined;
    // Whether the pane is the only thing on screen (phone), which is the one case that needs a way back.
    standalone?: boolean;
}>();

const emit = defineEmits<{
    // A reference inside the prose was clicked — the index's entries, and the notes' links to each other.
    open: [name: string];
    // The note is gone; the view owns the selection, so it decides what to show next.
    forgotten: [];
    back: [];
}>();

/* The in-progress edit, owned by the VIEW rather than this component: a draft has to survive reading another
 * note and coming back, and this pane is re-used (not remounted) as the selection moves. `undefined` means
 * "not editing" — one piece of state for both, so an editor can never be open with nothing in it. */
const draft = defineModel<string | undefined>(`draft`);

const selection = computed(() => ({ project, name }));
const { note, error: noteError, isLoading } = useMemoryFile(selection);
const { save, remove } = useMemoryMutations();

const isIndex = computed(() => name === INDEX_NAME);
const title = computed(() => (isIndex.value ? `Index` : noteTitle(name)));
// Edit round-trips the RAW file, frontmatter included, so a save is byte-identical apart from the edit itself.
const raw = computed(() => note.value?.content ?? ``);
const parsed = computed(() => parseNote(raw.value));

// The kind of fact this is. Worth a colour rather than a plain chip: scanning a project's notes, "what the
// agent believes about ME" and "what it believes about this REPO" are the distinction that matters.
const TYPE_VARIANT: Record<string, StatusVariant> = { user: `primary`, project: `info` };
const typeVariant = computed<StatusVariant>(() => TYPE_VARIANT[parsed.value.type ?? ``] ?? `neutral`);

const view = ref<`preview` | `source`>(`preview`);
const confirming = ref(false);
// Leaving the note drops the confirmation but never the draft — one is a question that expired, the other is
// the user's unsaved words.
watch(selection, () => (confirming.value = false), { deep: true });

const startEdit = (): void => {
    draft.value = raw.value;
    view.value = `preview`;
};
const cancelEdit = (): void => {
    draft.value = undefined;
};
const saveDraft = async (): Promise<void> => {
    if (draft.value === undefined) {
        return;
    }
    await save.mutateAsync({ project, name, content: draft.value });
    draft.value = undefined;
};
const forget = async (): Promise<void> => {
    await remove.mutateAsync({ project, name });
    draft.value = undefined;
    confirming.value = false;
    emit(`forgotten`);
};

const mutationError = computed(() => save.error.value?.message ?? remove.error.value?.message);

/* References to other notes are links, not text — see linkifyNoteRefs. They carry `data-note` instead of an
 * href (the destination is a selection in this view, not a URL), so one delegated listener on the prose turns
 * a click into a selection. Delegated because the anchors live inside v-html and can hold no component. */
const decorate = (fragment: DocumentFragment): void => linkifyNoteRefs(fragment, name);
const onProseClick = (event: MouseEvent): void => {
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>(`[data-note]`)?.dataset[`note`];
    if (target !== undefined) {
        event.preventDefault();
        emit(`open`, target);
    }
};
</script>

<template>
    <section class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-line bg-card">
        <!-- Stacked until there is room for both: at rail width the title and a five-control cluster on one
             row leave the note's name reading as "Fix…", and the name is the whole point of the header. -->
        <header class="flex shrink-0 flex-col gap-2 border-b border-line px-4 py-3 md:flex-row md:items-start md:justify-between md:gap-3">
            <div class="min-w-0">
                <div class="flex items-center gap-2">
                    <button
                        v-if="standalone"
                        type="button"
                        class="-ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted hover:bg-overlay hover:text-content"
                        aria-label="Back to all notes"
                        @click="emit(`back`)"
                    >
                        <Icon name="arrow-left" class="text-xs" />
                    </button>
                    <Icon :name="isIndex ? `sparkles` : `file`" class="shrink-0 text-xs text-subtle" />
                    <h2 class="min-w-0 truncate text-sm font-medium text-content">{{ title }}</h2>
                    <StatusBadge v-if="parsed.type" :variant="typeVariant" size="xs" :label="parsed.type" />
                    <StatusBadge v-if="draft !== undefined" variant="warning" size="xs" label="Unsaved" />
                </div>
                <p v-if="isIndex" class="mt-1 text-xs text-muted">Loaded at the start of every session — every note below it hangs off this.</p>
                <p v-else-if="parsed.description" class="mt-1 text-xs text-muted">{{ parsed.description }}</p>
                <p class="mt-1 flex flex-wrap items-center gap-x-1.5 text-2xs text-subtle">
                    <span class="truncate font-mono">{{ name }}</span>
                    <template v-if="entry">
                        <span aria-hidden="true">·</span>
                        <span>{{ formatBytes(entry.sizeBytes) }}</span>
                        <span aria-hidden="true">·</span>
                        <span :title="new Date(entry.modifiedAt).toLocaleString()">edited {{ freshness(entry.modifiedAt) }}</span>
                    </template>
                </p>
            </div>

            <div class="flex shrink-0 items-center gap-1.5">
                <template v-if="draft !== undefined">
                    <Button label="Cancel" size="small" severity="secondary" @click="cancelEdit" />
                    <Button label="Save" size="small" :loading="save.isPending.value" @click="saveDraft">
                        <template #icon><Icon name="save" /></template>
                    </Button>
                </template>
                <template v-else>
                    <Segmented
                        v-model="view"
                        size="xs"
                        :options="[
                            { label: `Preview`, value: `preview` },
                            { label: `Source`, value: `source`, title: `The raw markdown, frontmatter included` },
                        ]"
                    />
                    <CopyButton :text="raw" v-tooltip.top="'Copy the raw note'" />
                    <button
                        type="button"
                        class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-overlay hover:text-content"
                        aria-label="Edit this note"
                        v-tooltip.top="'Edit'"
                        @click="startEdit"
                    >
                        <Icon name="pencil" class="text-xs" />
                    </button>
                    <button
                        type="button"
                        class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-danger/10 hover:text-danger"
                        aria-label="Forget this note"
                        v-tooltip.top="'Forget'"
                        @click="confirming = true"
                    >
                        <Icon name="trash" class="text-xs" />
                    </button>
                </template>
            </div>
        </header>

        <!-- Destructive and irreversible, so it is confirmed in place: the sentence names what is lost, and the
             two answers sit apart from every other control on the pane. -->
        <div v-if="confirming" class="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-danger/30 bg-danger/10 px-4 py-2.5">
            <span class="text-xs text-danger">Forget “{{ title }}”? The agent stops recalling it — this can't be undone.</span>
            <div class="flex shrink-0 items-center gap-1.5">
                <Button label="Keep it" size="small" severity="secondary" @click="confirming = false" />
                <Button label="Forget it" size="small" severity="danger" :loading="remove.isPending.value" @click="forget" />
            </div>
        </div>

        <div v-if="noteError || mutationError" class="shrink-0 border-b border-danger/30 bg-danger/10 px-4 py-2 text-xs text-danger">
            {{ noteError ?? mutationError }}
        </div>

        <div class="scrollbar-thin min-h-0 flex-1 overflow-auto">
            <!-- One textarea, holding the whole file: a memory note is short, hand-written markdown, and a
                 structured editor over it would only get in the way of the correction being made. -->
            <textarea
                v-if="draft !== undefined"
                v-model="draft"
                spellcheck="false"
                aria-label="Note source"
                class="scrollbar-thin h-full min-h-64 w-full resize-none bg-transparent px-4 py-3 font-mono text-xs leading-relaxed text-content focus:outline-none"
                @keydown.ctrl.s.prevent="saveDraft"
                @keydown.meta.s.prevent="saveDraft"
                @keydown.esc="cancelEdit"
            ></textarea>
            <p v-else-if="isLoading" class="px-4 py-6 text-xs text-subtle">Loading…</p>
            <!-- Delegated click: the note links and the code blocks' copy buttons both live inside v-html. -->
            <Markdown
                v-else-if="view === `preview`"
                :source="parsed.body"
                :decorate="decorate"
                class="px-5 py-4"
                style="--prose-measure: 74ch"
                @click="onProseClick"
            />
            <Code v-else :code="raw" lang="markdown" :wrap="true" :copyable="false" class="px-3 py-3" />
        </div>
    </section>
</template>
