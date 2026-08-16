<script setup lang="ts">
import type { MemoryFileEntry } from "./contract";
import {
    freshness,
    formatBytes,
    formatTimestamp,
    Icon,
    Markdown,
    NoteEditor,
    SegmentedControl,
    StatusBadge,
    type StatusVariant,
    useNoteDraft,
} from "@intentic/extension-ui";
import { computed, ref } from "vue";
import { INDEX_NAME, linkifyNoteRefs, noteTitle, parseNote } from "./memoryNote";
import { useMemoryFile, useMemoryMutations } from "./useMemory";

/* One memory note, read and curated: the agent's own words rendered as prose, the raw file behind a Source
 * toggle, and the two edits an owner ever wants to make — correct a fact, or make the agent forget it.
 *
 * The FRAME is <NoteEditor>'s — the action cluster, the confirmation, the error strip, and the one surface the
 * file is both read and written on. What is left here is what makes this a MEMORY note: the frontmatter it is
 * described by, the index's special standing, and the sibling references in its prose.
 *
 * FORGET, NOT DELETE, and the word is the whole of what this pane tells the frame about the destructive
 * action. A memory note is what the agent recalls; the file going away is the mechanism, not the point. */

const { project, name, entry } = defineProps<{
    project: string;
    name: string;
    // The list entry this note came from — its size and mtime are already known, so the header needs no fetch.
    entry: MemoryFileEntry | undefined;
}>();

const emit = defineEmits<{
    // A reference inside the prose was clicked — the index's entries, and the notes' links to each other.
    open: [name: string];
    // The note is gone; the view owns the selection, so it decides what to show next.
    forgotten: [];
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

const {
    source,
    editing,
    confirming,
    error: writeError,
    saving,
    removing,
    startEdit,
    cancelEdit,
    saveDraft,
    forget,
} = useNoteDraft({
    draft,
    raw: () => raw.value,
    save: (content) => save.mutateAsync({ project, name, content }),
    remove: () => remove.mutateAsync({ project, name }),
    note: () => selection.value,
    onRemoved: () => emit(`forgotten`),
});

// Editing lands on the SOURCE, because the source is what is being edited. It used to switch to Preview, which
// was invisible only because the old textarea covered the whole pane; now that the two are one surface, the
// same line would have taken the user off the thing they just clicked Edit on.
const edit = (): void => {
    startEdit();
    view.value = `source`;
};

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
    <!-- The stacking rule this header needed — title on its own row until there is width for the control
         cluster — belongs to the frame now: this pane is the narrowest real instance of it, and so the one that
         found the failure. -->
    <NoteEditor
        v-model:source="source"
        v-model:confirming="confirming"
        :title="title"
        :raw="raw"
        :editing="editing"
        :show-source="view === `source`"
        :loading="isLoading"
        :saving="saving"
        :removing="removing"
        :error="noteError ?? writeError"
        verb="Forget"
        @edit="edit"
        @cancel="cancelEdit"
        @save="saveDraft"
        @remove="forget"
    >
        <template #lead>
            <Icon :name="isIndex ? `sparkles` : `file`" class="shrink-0 text-xs text-subtle" />
        </template>
        <template #badges>
            <StatusBadge v-if="parsed.type" :variant="typeVariant" size="xs" :label="parsed.type" />
        </template>
        <template #description>
            <span v-if="isIndex">Loaded at the start of every session — every note below it hangs off this.</span>
            <span v-else-if="parsed.description">{{ parsed.description }}</span>
        </template>
        <template #meta>
            <span class="truncate font-mono">{{ name }}</span>
            <template v-if="entry">
                <span aria-hidden="true">·</span>
                <span>{{ formatBytes(entry.sizeBytes) }}</span>
                <span aria-hidden="true">·</span>
                <span :title="formatTimestamp(entry.modifiedAt)">edited {{ freshness(entry.modifiedAt) }}</span>
            </template>
        </template>

        <!-- Two views and nothing else, so they fit the header's row beside the icon buttons — unlike the
             knowledge pane, which has three and a map to make room for. -->
        <template #actions>
            <SegmentedControl
                v-model="view"
                size="xs"
                :options="[
                    { label: `Preview`, value: `preview` },
                    { label: `Source`, value: `source`, title: `The raw markdown, frontmatter included` },
                ]"
            />
        </template>

        <template #confirm>Forget “{{ title }}”? The agent stops recalling it — this can't be undone.</template>

        <!-- Delegated click: the note links and the code blocks' copy buttons both live inside v-html. -->
        <Markdown :source="parsed.body" :decorate="decorate" class="px-5 py-4" style="--prose-measure: 74ch" @click="onProseClick" />
    </NoteEditor>
</template>
