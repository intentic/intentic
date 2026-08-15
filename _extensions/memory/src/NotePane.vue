<script setup lang="ts">
import type { MemoryFileEntry } from "./contract";
import {
    Button,
    CodeField,
    ui,
    CopyButton,
    formatBytes,
    formatTimestamp,
    Icon,
    Markdown,
    ScrollFrame,
    SegmentedControl,
    StatusBadge,
    type StatusVariant,
} from "@intentic/extension-ui";
import { computed, ref, watch } from "vue";
import { INDEX_NAME, linkifyNoteRefs, noteTitle, parseNote } from "./memoryNote";
import { freshness } from "./noteTime";
import { useMemoryFile, useMemoryMutations } from "./useMemory";

/* One memory note, read and curated: the agent's own words rendered as prose, the raw file behind a Source
 * toggle, and the two edits an owner ever wants to make — correct a fact, or make the agent forget it.
 *
 * Reading is the default and gets the whole pane; the controls sit in one header row above it. The three
 * states (read / edit / confirm-forget) are mutually exclusive on purpose — an editor open over a note that is
 * half-deleted is a way to lose work, not a feature.
 *
 * SOURCE AND EDIT ARE ONE SURFACE — <CodeField>, readonly or not. They used to be two: a coloured <Code> block
 * to read the markdown in, and a bare grey <textarea> to change it in. So the file changed typeface, colour,
 * leading and size at the moment you picked up the pen, and — because that textarea was `h-full min-h-64` in a
 * panel with no height to be full OF — it also shrank to 256px, showing seven lines of a note and hiding the
 * rest behind a scrollbar. One surface cannot drift from itself, and it is sized by the file rather than by a
 * number, so the pane shows the whole note and this panel's own frame decides when to scroll. */

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
const confirming = ref(false);
// Leaving the note drops the confirmation but never the draft — one is a question that expired, the other is
// the user's unsaved words.
watch(selection, () => (confirming.value = false), { deep: true });

/* What the source surface shows: the draft while one is open, the file otherwise. One binding for both, so
 * reading the markdown and editing it cannot get out of step — the field is the same element either way, and
 * `readonly` is the only thing that changes about it. */
const source = computed<string>({
    get: () => draft.value ?? raw.value,
    set: (next) => {
        draft.value = next;
    },
});

// Editing lands on the SOURCE, because the source is what is being edited. It used to switch to Preview, which
// was invisible only because the old textarea covered the whole pane; now that the two are one surface, the
// same line would have taken the user off the thing they just clicked Edit on.
const startEdit = (): void => {
    draft.value = raw.value;
    view.value = `source`;
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
    <!-- The stacking rule this header needed — title on its own row until there is width for the control
         cluster — is <ScrollFrame>'s now: this pane is the narrowest real instance of it, and so the one that found
         the failure. -->
    <ScrollFrame grow :title="title">
        <template #lead>
            <Icon :name="isIndex ? `sparkles` : `file`" class="shrink-0 text-xs text-subtle" />
        </template>
        <template #badges>
            <StatusBadge v-if="parsed.type" :variant="typeVariant" size="xs" :label="parsed.type" />
            <StatusBadge v-if="draft !== undefined" variant="warning" size="xs" label="Unsaved" />
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

        <template #actions>
            <template v-if="draft !== undefined">
                <Button label="Cancel" size="small" severity="secondary" @click="cancelEdit" />
                <Button label="Save" size="small" :loading="save.isPending.value" @click="saveDraft">
                    <template #icon><Icon name="save" /></template>
                </Button>
            </template>
            <template v-else>
                <SegmentedControl
                    v-model="view"
                    size="xs"
                    :options="[
                        { label: `Preview`, value: `preview` },
                        { label: `Source`, value: `source`, title: `The raw markdown, frontmatter included` },
                    ]"
                />
                <CopyButton :text="raw" v-tooltip.top="'Copy the raw note'" />
                <button type="button" :class="ui.iconButton(`h-7 w-7`)" aria-label="Edit this note" v-tooltip.top="'Edit'" @click="startEdit">
                    <Icon name="pencil" />
                </button>
                <button
                    type="button"
                    :class="ui.iconButton(`h-7 w-7 hover:bg-danger/10 hover:text-danger`)"
                    aria-label="Forget this note"
                    v-tooltip.top="'Forget'"
                    @click="confirming = true"
                >
                    <Icon name="trash" />
                </button>
            </template>
        </template>

        <!-- Destructive and irreversible, so it is confirmed in place: the sentence names what is lost, and the
             two answers sit apart from every other control on the pane. Rides #strips so a long note can never
             scroll the question away from the answer. -->
        <template v-if="confirming || noteError || mutationError" #strips>
            <div v-if="confirming" class="flex flex-wrap items-center justify-between gap-2 border-b border-danger/30 bg-danger/10 px-4 py-2.5">
                <span class="text-xs text-danger">Forget “{{ title }}”? The agent stops recalling it — this can't be undone.</span>
                <div class="flex shrink-0 items-center gap-1.5">
                    <Button label="Keep it" size="small" severity="secondary" @click="confirming = false" />
                    <Button label="Forget it" size="small" severity="danger" :loading="remove.isPending.value" @click="forget" />
                </div>
            </div>
            <div v-if="noteError || mutationError" class="border-b border-danger/30 bg-danger/10 px-4 py-2 text-xs text-danger">
                {{ noteError ?? mutationError }}
            </div>
        </template>

        <p v-if="isLoading && draft === undefined" class="px-4 py-6 text-xs text-subtle">Loading…</p>
        <!-- Delegated click: the note links and the code blocks' copy buttons both live inside v-html. -->
        <Markdown
            v-else-if="draft === undefined && view === `preview`"
            :source="parsed.body"
            :decorate="decorate"
            class="px-5 py-4"
            style="--prose-measure: 74ch"
            @click="onProseClick"
        />
        <!-- The whole file, frontmatter included, in markdown's own colours — read with `readonly`, written
             without it. A memory note is short, hand-written markdown, and a structured editor over it would
             only get in the way of the correction being made. -->
        <CodeField
            v-else
            v-model="source"
            lang="markdown"
            :readonly="draft === undefined"
            aria-label="Note source"
            @keydown.ctrl.s.prevent="saveDraft"
            @keydown.meta.s.prevent="saveDraft"
            @keydown.esc="cancelEdit"
        />
    </ScrollFrame>
</template>
