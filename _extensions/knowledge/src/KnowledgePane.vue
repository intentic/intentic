<script setup lang="ts">
import {
    freshness,
    formatBytes,
    formatTimestamp,
    Icon,
    InfoTable,
    Markdown,
    NoteEditor,
    SegmentedControl,
    StatusBadge,
    type StatusVariant,
    useNoteDraft,
} from "@intentic/extension-ui";
import { computed, ref, toRef } from "vue";
import { linkifyNoteRefs, toneOfType } from "./knowledgeNote";
import NoteGraph from "./NoteGraph.vue";
import { useNote, useNoteMutations } from "./useKnowledge";

/* ONE KNOWLEDGE NOTE: what it is, what it says, and what it is connected to.
 *
 * The FRAME is <NoteEditor>'s: the action cluster, the delete confirmation, the error strip, and the one
 * surface the markdown is both read and written on. What is left here is what makes this a KNOWLEDGE note
 * rather than any other: the three views, the header's facts, and the connections bar.
 *
 * THREE VIEWS OF THE SAME THING, because a knowledge note genuinely has three: the prose you read, the map of
 * what it connects to, and the file underneath. They are one control rather than three panels stacked down the
 * pane: this lives in a hub section, which is a band rather than a page, and a map worth reading needs most of
 * that band's height. Reading is the default; the other two are one click and they remember nothing, so nobody
 * lands somewhere they did not choose.
 *
 * THE CONNECTIONS ARE ALWAYS ON SCREEN, under whichever view is open: they are the reason this is a knowledge
 * base rather than a folder, and putting them behind the map tab would mean the answer to "what else is about
 * this" required knowing to go and look. Each one is a link, with the relationship named, so following a chain
 * is a click per step. */

const { path } = defineProps<{ path: string }>();
const emit = defineEmits<{ open: [path: string]; filter: [path: string]; forgotten: [] }>();

/* The in-progress edit, owned by the VIEW rather than this pane: a draft has to survive reading another note
 * and coming back, and this pane is reused as the selection moves. `undefined` means "not editing": one piece
 * of state for both, so an editor can never be open with nothing in it. */
const draft = defineModel<string | undefined>(`draft`);

const { note, error: noteError, isLoading } = useNote(toRef(() => path));
const { save, remove } = useNoteMutations();

const raw = computed(() => note.value?.content ?? ``);
const view = ref<`read` | `map` | `source`>(`read`);

// Leaving the note puts the view back but never the draft: one is where you happened to be looking, the other
// is the reader's unsaved words. The confirmation and the last error go with it, inside the composable.
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

// Editing lands on the SOURCE, because the source is what is being edited, and it is where Cancel leaves you,
// looking at the file you just decided not to change.
const edit = (): void => {
    startEdit();
    view.value = `source`;
};

// The header's plain facts, as a label→value block. `InfoTable` rather than a hand-rolled grid because keeping
// the value column aligned across rows is the whole of it, and that is where a hand-roll drifts.
const facts = computed<string[][]>(() => (note.value?.facts ?? []).map((fact) => [fact.key, fact.values.join(`, `)]));

/* Resolution is the backend's answer, not a second set of rules here: every link this note holds arrived
 * already resolved, so the prose decorator is a lookup over that. A target that isn't in it is a note nobody
 * has written: drawn as unfinished rather than as a link that goes nowhere. */
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
    <!-- The pane is the note; the bar under it is what the note is CONNECTED to. Two elements rather than one,
         because <NoteEditor>'s body scrolls and the connections must not scroll away: they are the reason this is
         a knowledge base rather than a folder, and on a long note they would otherwise be a page down. -->
    <div class="flex min-h-0 flex-1 flex-col gap-2">
        <NoteEditor
            v-model:source="source"
            v-model:confirming="confirming"
            :title="note?.summary.title ?? `…`"
            :raw="raw"
            :editing="editing"
            :show-source="view === `source`"
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
            <!-- WHAT KIND OF THING THIS IS, and nothing else. A badge sits beside the title on the header's one
                 shrinking row, so every additional one is width taken off the note's NAME, and a note's tags are
                 open-ended, so a well-tagged note here truncated its own title to a single letter. The kind is the
                 one fact worth that trade; the tags moved to the meta line below, which wraps. -->
            <template #badges>
                <StatusBadge
                    v-if="note?.summary.type"
                    :variant="toneOfType(note.summary.type) as StatusVariant"
                    size="xs"
                    :label="note.summary.type"
                />
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

            <!-- WHICH VIEW rides a row of its own rather than the header's, and that is width, not taste: a
                 header's title, badges and actions share ONE shrinking row, and this control is ~140px of it:
                 beside three icon buttons in a pane this narrow, the note's own NAME truncated to a single
                 letter. It also belongs here on the merits: the switch is about the body underneath it, not
                 about the note the header names. -->
            <template #strips>
                <div class="flex items-center gap-2 border-b border-line px-4 py-1.5">
                    <SegmentedControl
                        v-model="view"
                        size="xs"
                        :options="[
                            { label: `Read`, value: `read` },
                            { label: `Map`, value: `map`, title: `What this note connects to, a step or two out` },
                            { label: `Source`, value: `source`, title: `The raw markdown, header included` },
                        ]"
                    />
                </div>
            </template>

            <template #confirm> Delete "{{ note?.summary.title }}"? Anything that links to it becomes a link to a note nobody has written. </template>

            <NoteGraph v-if="view === `map`" :path="path" @open="emit(`open`, $event)" />

            <template v-else>
                <!-- The header's plain facts, above the prose: these are what somebody came to look up.
                     Padded by a wrapper rather than by the table, because horizontal padding on a <table>
                     does not indent its cells: the labels sat flush against the panel's edge. -->
                <div v-if="facts.length > 0" class="px-5 pt-4">
                    <InfoTable :rows="facts" />
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
            </template>
        </NoteEditor>

        <!-- WHAT THIS IS CONNECTED TO, under every view and outside the scroller. Each entry is a step you can
         take, and the relationship's name is what tells you whether taking it will answer your question. -->
        <div
            v-if="note && (note.linksTo.length > 0 || note.linkedFrom.length > 0)"
            class="flex shrink-0 flex-col gap-1.5 rounded-lg border border-line px-4 py-2.5 text-xs"
        >
            <div v-if="note.linksTo.length > 0" class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span class="text-2xs uppercase tracking-wide text-subtle">Links to</span>
                <span v-for="(link, i) in note.linksTo" :key="`out-${link.relation ?? ``}-${link.title}-${i}`" class="flex items-baseline gap-1">
                    <span v-if="link.relation" class="text-2xs text-subtle">{{ link.relation }}</span>
                    <button v-if="link.path" type="button" class="text-link hover:underline" @click="emit(`open`, link.path)">
                        {{ link.title }}
                    </button>
                    <span v-else class="text-subtle underline decoration-dotted underline-offset-2" :title="`No note for &quot;${link.title}&quot; yet`">
                        {{ link.title }}
                    </span>
                </span>
            </div>
            <div v-if="note.linkedFrom.length > 0" class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span class="text-2xs uppercase tracking-wide text-subtle">Linked from</span>
                <span v-for="(link, i) in note.linkedFrom" :key="`in-${link.relation ?? ``}-${link.title}-${i}`" class="flex items-baseline gap-1">
                    <span v-if="link.relation" class="text-2xs text-subtle">{{ link.relation }}</span>
                    <button v-if="link.path" type="button" class="text-link hover:underline" @click="emit(`open`, link.path)">
                        {{ link.title }}
                    </button>
                </span>
                <!-- "Everything about this note" is a different question from "what links to it", and it is the one
                 a reader asks next: it re-aims the list beside the pane. -->
                <button type="button" class="ml-auto shrink-0 text-2xs text-link hover:underline" @click="emit(`filter`, path)">
                    Show these in the list
                </button>
            </div>
        </div>
    </div>
</template>
