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

/* ONE KNOWLEDGE NOTE: what it is, what it says, and what it is connected to.
 *
 * The FRAME is <NoteEditor>'s: the action cluster, the delete confirmation, the error strip, and the one
 * surface the markdown is both read and written on. What is left here is what makes this a KNOWLEDGE note
 * rather than any other: the three views, the head's facts, and the connections.
 *
 * THREE VIEWS OF THE SAME THING, because a knowledge note genuinely has three: the prose you read, the map of
 * what it connects to, and the file underneath. They are one switch rather than three panels stacked down the
 * pane: this lives in a hub section, which is a band rather than a page, and a map worth reading needs most of
 * that band's height. Reading is the default; the other two are one click and they remember nothing, so nobody
 * lands somewhere they did not choose.
 *
 * THE SWITCH IS TWO WAYS OUT OF THE NOTE, NOT A THREE-WAY PICKER, which is the shape the workspace's markdown
 * viewer already settled on and the shape that fits on the header's row. A <SegmentedControl> spelling all
 * three is ~140px wide and could not share a line with the note's name and the Copy/Edit/Delete cluster, so it
 * had a row of its own under the header: ~34px of every screenful, permanently, for a control that is pressed
 * once a session. As two glyph toggles it is ~62px and rides beside the others.
 *
 * Reading is not one of the three buttons because reading is not a destination: it is where the note IS, and
 * both toggles return to it, which is why each one turns into an eye while it is the view on screen. Losing
 * the words costs discoverability, and that is bought back the way the viewer buys it, with a tooltip and an
 * accessible name that say what the press will DO rather than what the button is called.
 *
 * ── THE CONNECTIONS SIT WHERE THE QUESTION THEY ANSWER IS ASKED ───────────────────────────────────────────
 *
 * They used to be one bar under the whole pane, pinned outside the frame's scroller on the reasoning that they
 * are the reason this is a knowledge base rather than a folder and must never scroll away. The reasoning was
 * right and the pin was the wrong way to buy it: pinning them cost the note its length (the frame had to be
 * clamped for the bar to have somewhere to be pinned outside of), so the way to the next note was bought with
 * the ability to read this one. Split by the question each half answers, neither needs pinning:
 *
 *  · LINKS TO is part of what this note SAYS. It goes in the head, beside the facts: `employer: Acme` and
 *    `works_on → Storefront` are the same kind of claim, one written as a field and one as a link, and a reader
 *    scanning the head for "what is this thing" wants both in one place.
 *  · LINKED FROM is a see-also. It is the question you ask AFTER reading, nobody looks it up mid-sentence, and
 *    at the end of the note is exactly where the wikis this borrows the idea from put it.
 *
 * Each one is still a link with the relationship named, so following a chain is a click per step. */

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
    <!-- ONE ELEMENT NOW: the note IS the pane. The connections used to be a second, pinned under the frame,
         which is what the clamp on this section existed to make room for; they are inside the note's own
         document now (see the note above), so the frame is free to be as long as the note is. -->
    <NoteEditor
        v-model:source="source"
        v-model:confirming="confirming"
        paged
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

        <!-- WHICH VIEW, on the header's own row and to the left of Copy/Edit/Delete: the caller's controls go
                 first because they are about the note, where that cluster is about the FILE. Both are one press
                 away from reading and neither remembers anything, so there is no state here to get lost in.
                 <NoteEditor> drops this whole slot while a draft is open, which is right: an editor is already
                 the source, so a button offering to show it would do nothing, and one offering the map would
                 throw the draft off screen. -->
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
            <button
                type="button"
                :class="ui.iconButton(`h-7 w-7`)"
                :aria-pressed="view === `source`"
                :aria-label="view === `source` ? `Back to the note` : `Show the raw markdown`"
                v-tooltip.top="view === `source` ? `Back to the note` : `Source: the raw markdown, header included`"
                @click="view = view === `source` ? `read` : `source`"
            >
                <Icon :name="view === `source` ? `eye` : `code`" />
            </button>
        </template>

        <template #confirm> Delete "{{ note?.summary.title }}"? Anything that links to it becomes a link to a note nobody has written. </template>

        <NoteGraph v-if="view === `map`" :path="path" @open="emit(`open`, $event)" />

        <template v-else>
            <!-- THE HEAD: what this thing IS. The plain facts and the outbound links, together, because they are
                 the same kind of claim written two ways: `employer: Acme` is a field and `works_on → Storefront`
                 is a link, and a reader scanning for what a note is about wants neither of them at the far end
                 of the prose. Padded by a wrapper rather than by the table, because horizontal padding on a
                 <table> does not indent its cells: the labels sat flush against the panel's edge. -->
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

            <!-- THE TAIL: a see-also. What ELSE mentions this note is the question a reader asks having finished
                 it, so it sits where they finish, ruled off from the prose rather than boxed: a bordered card at
                 the end of a document reads as a different document. -->
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
                <!-- "Everything about this note" is a different question from "what links to it", and it is the one
                     a reader asks next: it re-aims the list beside the pane. -->
                <button type="button" :class="ui.linkButton(`ml-auto shrink-0 text-2xs`)" @click="emit(`filter`, path)">
                    Show these in the list
                </button>
            </div>
        </template>
    </NoteEditor>
</template>
