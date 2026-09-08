<script setup lang="ts">
import {
    freshness,
    formatBytes,
    formatTimestamp,
    Icon,
    InfoTable,
    Markdown,
    NoteEditor,
    StatusBadge,
    type StatusVariant,
    useNoteDraft,
    ui,
} from "@intentic/extension-ui";
import { computed, ref, toRef } from "vue";
import { linkifyNoteRefs, toneOfType } from "./knowledgeNote";
import NoteGraph from "./NoteGraph.vue";
import { useNote, useNoteMutations } from "./useKnowledge";

// One knowledge note: what it is, what it says, what it connects to. NoteEditor supplies the frame (actions, delete,
// errors, the read/write surface); this adds the map toggle, the header's facts, and the links. Links-to sits in the
// head beside the facts (the same kind of claim); linked-from is a see-also at the tail.

const { path } = defineProps<{ path: string }>();
const emit = defineEmits<{ open: [path: string]; filter: [path: string]; forgotten: [] }>();

// Owned by the view, not this pane, so a draft survives leaving and returning; undefined means not editing.
const draft = defineModel<string | undefined>(`draft`);

const { note, error: noteError, isLoading } = useNote(toRef(() => path));
const { save, remove } = useNoteMutations();

const raw = computed(() => note.value?.content ?? ``);
const view = ref<`read` | `map`>(`read`);

// Leaving resets the view but never the draft; the confirmation and last error live inside this composable.
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
    save: (content) => save.mutateAsync({ path, content }),
    remove: () => remove.mutateAsync({ path }),
    note: () => path,
    onLeave: () => (view.value = `read`),
    onRemoved: () => emit(`forgotten`),
});

// Edits happen on the note itself, in place, not a separate view; steps out of the map, since a draft you can't see is
// one you'll lose.
const edit = (): void => {
    startEdit();
    view.value = `read`;
};

// The header's facts as label→value rows; `InfoTable` keeps the value column aligned across them.
const facts = computed<string[][]>(() => (note.value?.facts ?? []).map((fact) => [fact.key, fact.values.join(`, `)]));

// Resolution is the backend's answer already; an unresolved target is unwritten, drawn unfinished, not broken.
const resolved = computed(() => new Map((note.value?.linksTo ?? []).map((link) => [link.title, link.path])));
const decorate = (fragment: DocumentFragment): void => linkifyNoteRefs(fragment, (target) => resolved.value.get(target));
const onProseClick = (event: MouseEvent): void => {
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>(`[data-kb]`)?.dataset[`kb`];
    if (target !== undefined) {
        event.preventDefault();
        emit(`open`, target);
    }
};
</script>

<template>
    <!-- One element: the note is the pane, so the frame's length is the note's, not clamped for another section. -->
    <NoteEditor
        v-model:source="source"
        v-model:confirming="confirming"
        paged
        :title="note?.summary.title ?? `…`"
        :raw="raw"
        :editing="editing"
        :loading="isLoading"
        :saving="saving"
        :removing="removing"
        :error="noteError ?? writeError"
        @edit="edit"
        @cancel="cancelEdit"
        @save="saveDraft"
        @remove="forget"
    >
        <template #lead>
            <Icon name="file" class="shrink-0 text-xs text-subtle" />
        </template>
        <!-- The type badge only: it costs width off the note's name on this row, and tags already live on the meta line. -->
        <template #badges>
            <StatusBadge v-if="note?.summary.type" :variant="toneOfType(note.summary.type) as StatusVariant" size="xs" :label="note.summary.type" />
        </template>
        <template #description>
            <span v-if="note?.summary.aliases.length">Also called {{ note.summary.aliases.join(`, `) }}.</span>
        </template>
        <template #meta>
            <span class="truncate font-mono">{{ path }}</span>
            <template v-if="note">
                <span aria-hidden="true">·</span>
                <span>{{ formatBytes(note.summary.sizeBytes) }}</span>
                <span aria-hidden="true">·</span>
                <span :title="formatTimestamp(note.summary.modifiedAt)">edited {{ freshness(note.summary.modifiedAt) }}</span>
                <template v-if="note.summary.tags.length > 0">
                    <span aria-hidden="true">·</span>
                    <span v-for="tag in note.summary.tags" :key="tag">#{{ tag }}</span>
                </template>
            </template>
        </template>

        <!-- Left of Copy/Edit/Delete since it's about the note, not the file; hidden while a draft is open. -->
        <template #actions>
            <button
                type="button"
                :class="ui.iconButton(`h-7 w-7`)"
                :aria-pressed="view === `map`"
                :aria-label="view === `map` ? `Back to the note` : `Show what this note connects to`"
                v-tooltip.top="view === `map` ? `Back to the note` : `Map: what this note connects to`"
                @click="view = view === `map` ? `read` : `map`"
            >
                <Icon :name="view === `map` ? `eye` : `sitemap`" />
            </button>
        </template>

        <template #confirm> Delete "{{ note?.summary.title }}"? Anything that links to it becomes a link to a note nobody has written. </template>

        <NoteGraph v-if="view === `map`" :path="path" @open="emit(`open`, $event)" />

        <template v-else>
            <!-- Facts and outbound links together, since a `<table>`'s own padding won't indent its cells (the wrapper does). -->
            <div v-if="facts.length > 0 || (note?.linksTo.length ?? 0) > 0" class="flex flex-col gap-2.5 px-5 pt-4">
                <InfoTable v-if="facts.length > 0" :rows="facts" />
                <div v-if="note && note.linksTo.length > 0" class="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
                    <span class="text-2xs uppercase tracking-wide text-subtle">Links to</span>
                    <span v-for="(link, i) in note.linksTo" :key="`out-${link.relation ?? ``}-${link.title}-${i}`" class="flex items-baseline gap-1">
                        <span v-if="link.relation" class="text-2xs text-subtle">{{ link.relation }}</span>
                        <button v-if="link.path" type="button" class="text-link hover:underline" @click="emit(`open`, link.path)">
                            {{ link.title }}
                        </button>
                        <span
                            v-else
                            class="text-subtle underline decoration-dotted underline-offset-2"
                            :title="`No note for &quot;${link.title}&quot; yet`"
                        >
                            {{ link.title }}
                        </span>
                    </span>
                </div>
            </div>
            <Markdown
                v-if="(note?.body ?? ``).trim() !== ``"
                :source="note?.body ?? ``"
                :decorate="decorate"
                class="px-5 py-4"
                style="--prose-measure: 74ch"
                @click="onProseClick"
            />
            <p v-else class="px-5 py-4 text-xs text-subtle">No text yet: this note is its header.</p>

            <!-- A see-also, ruled off rather than boxed: a bordered card at a document's end reads as a different document. -->
            <div
                v-if="note && note.linkedFrom.length > 0"
                class="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-line-subtle px-5 py-3 text-xs"
            >
                <span class="text-2xs uppercase tracking-wide text-subtle">Linked from</span>
                <span v-for="(link, i) in note.linkedFrom" :key="`in-${link.relation ?? ``}-${link.title}-${i}`" class="flex items-baseline gap-1">
                    <span v-if="link.relation" class="text-2xs text-subtle">{{ link.relation }}</span>
                    <button v-if="link.path" type="button" class="text-link hover:underline" @click="emit(`open`, link.path)">
                        {{ link.title }}
                    </button>
                </span>
                <!-- "Everything about this note" differs from "what links to it"; this re-aims the list beside the pane. -->
                <button type="button" :class="ui.linkButton(`ml-auto shrink-0 text-2xs`)" @click="emit(`filter`, path)">
                    Show these in the list
                </button>
            </div>
        </template>
    </NoteEditor>
</template>
