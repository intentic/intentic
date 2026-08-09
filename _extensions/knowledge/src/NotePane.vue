<script setup lang="ts">
import {
    Button,
    cmp,
    CodeField,
    CopyButton,
    formatBytes,
    formatTimestamp,
    Icon,
    InfoTable,
    Markdown,
    Panel,
    Segmented,
    StatusBadge,
    type StatusVariant,
} from "@intentic/extension-ui";
import { computed, ref, toRef, watch } from "vue";
import { linkifyVaultRefs, toneOfType } from "./knowledgeNote";
import NoteGraph from "./NoteGraph.vue";
import { freshness } from "./noteTime";
import { useNote, useNoteMutations } from "./useKnowledge";

/* ONE NOTE — what it is, what it says, and what it is connected to.
 *
 * THREE VIEWS OF THE SAME THING, because a knowledge note genuinely has three: the prose you read, the map of
 * what it connects to, and the file underneath. They are one control rather than three panels stacked down the
 * pane: this lives in a hub section, which is a band rather than a page, and a map worth reading needs most of
 * that band's height. Reading is the default; the other two are one click and they remember nothing, so nobody
 * lands somewhere they did not choose.
 *
 * THE CONNECTIONS ARE ALWAYS ON SCREEN, under whichever view is open — they are the reason this is a knowledge
 * base rather than a folder, and putting them behind the map tab would mean the answer to "what else is about
 * this" required knowing to go and look. Each one is a link, with the relationship named, so following a chain
 * is a click per step.
 *
 * Source and edit are ONE surface (<CodeField>, readonly or not) — the memory extension's rule and its reason:
 * a note that changed typeface and colour the moment you picked up the pen was two implementations of the same
 * pane, and they drifted. */

const { path } = defineProps<{ path: string }>();
const emit = defineEmits<{ open: [path: string]; filter: [path: string]; forgotten: [] }>();

/* The in-progress edit, owned by the VIEW rather than this pane: a draft has to survive reading another note
 * and coming back, and this pane is reused as the selection moves. `undefined` means "not editing" — one piece
 * of state for both, so an editor can never be open with nothing in it. */
const draft = defineModel<string | undefined>(`draft`);

const { note, error: noteError, isLoading } = useNote(toRef(() => path));
const { save, remove } = useNoteMutations();

const raw = computed(() => note.value?.content ?? ``);
const view = ref<`read` | `map` | `source`>(`read`);
const confirming = ref(false);
// Leaving the note drops the confirmation but never the draft — one is a question that expired, the other is
// the reader's unsaved words.
watch(
    () => path,
    () => {
        confirming.value = false;
        view.value = `read`;
    },
);

const source = computed<string>({
    get: () => draft.value ?? raw.value,
    set: (next) => {
        draft.value = next;
    },
});

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
    await save.mutateAsync({ path, content: draft.value });
    draft.value = undefined;
};
const forget = async (): Promise<void> => {
    await remove.mutateAsync({ path });
    draft.value = undefined;
    confirming.value = false;
    emit(`forgotten`);
};

const mutationError = computed(() => save.error.value?.message ?? remove.error.value?.message);

// The header's plain facts, as a label→value block. `InfoTable` rather than a hand-rolled grid because keeping
// the value column aligned across rows is the whole of it, and that is where a hand-roll drifts.
const facts = computed<string[][]>(() => (note.value?.facts ?? []).map((fact) => [fact.key, fact.values.join(`, `)]));

/* Resolution is the backend's answer, not a second set of rules here: every link this note holds arrived
 * already resolved, so the prose decorator is a lookup over that. A target that isn't in it is a note nobody
 * has written — drawn as unfinished rather than as a link that goes nowhere. */
const resolved = computed(() => new Map((note.value?.linksTo ?? []).map((link) => [link.title, link.path])));
const decorate = (fragment: DocumentFragment): void => linkifyVaultRefs(fragment, (target) => resolved.value.get(target));
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
         because <Panel>'s body scrolls and the connections must not scroll away — they are the reason this is a
         knowledge base rather than a folder, and on a long note they would otherwise be a page down. -->
    <div class="flex min-h-0 flex-1 flex-col gap-2">
        <Panel grow :title="note?.summary.title ?? `…`">
            <template #lead>
                <Icon name="file" class="shrink-0 text-xs text-subtle" />
            </template>
            <!-- WHAT KIND OF THING THIS IS, and nothing else. A badge sits beside the title on the header's one
                 shrinking row, so every additional one is width taken off the note's NAME — and a note's tags are
                 open-ended, so a well-tagged note here truncated its own title to a single letter. The kind is the
                 one fact worth that trade; the tags moved to the meta line below, which wraps. -->
            <template #badges>
                <StatusBadge
                    v-if="note?.summary.type"
                    :variant="toneOfType(note.summary.type) as StatusVariant"
                    size="xs"
                    :label="note.summary.type"
                />
                <StatusBadge v-if="draft !== undefined" variant="warning" size="xs" label="Unsaved" />
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

            <template #actions>
                <template v-if="draft !== undefined">
                    <Button label="Cancel" size="small" severity="secondary" @click="cancelEdit" />
                    <Button label="Save" size="small" :loading="save.isPending.value" @click="saveDraft">
                        <template #icon><Icon name="save" /></template>
                    </Button>
                </template>
                <template v-else>
                    <CopyButton :text="raw" v-tooltip.top="'Copy the raw note'" />
                    <button type="button" :class="cmp.iconButton(`h-7 w-7`)" aria-label="Edit this note" v-tooltip.top="'Edit'" @click="startEdit">
                        <Icon name="pencil" />
                    </button>
                    <button
                        type="button"
                        :class="cmp.iconButton(`h-7 w-7 hover:bg-danger/10 hover:text-danger`)"
                        aria-label="Delete this note"
                        v-tooltip.top="'Delete'"
                        @click="confirming = true"
                    >
                        <Icon name="trash" />
                    </button>
                </template>
            </template>

            <!-- WHICH VIEW rides a row of its own rather than the header's, and that is width, not taste: a
                 header's title, badges and actions share ONE shrinking row, and this control is ~140px of it —
                 beside three icon buttons in a pane this narrow, the note's own NAME truncated to a single
                 letter. It also belongs here on the merits: the switch is about the body underneath it, not
                 about the note the header names.

                 Destructive and irreversible, so the delete confirmation rides this slot too, where a long note
                 cannot scroll the question away from the answer. -->
            <template #strips>
                <div v-if="draft === undefined" class="flex items-center gap-2 border-b border-line px-4 py-1.5">
                    <Segmented
                        v-model="view"
                        size="xs"
                        :options="[
                            { label: `Read`, value: `read` },
                            { label: `Map`, value: `map`, title: `What this note connects to, a step or two out` },
                            { label: `Source`, value: `source`, title: `The raw markdown, header included` },
                        ]"
                    />
                </div>
                <div v-if="confirming" class="flex flex-wrap items-center justify-between gap-2 border-b border-danger/30 bg-danger/10 px-4 py-2.5">
                    <span class="text-xs text-danger">
                        Delete “{{ note?.summary.title }}”? Anything that links to it becomes a link to a note nobody has written.
                    </span>
                    <div class="flex shrink-0 items-center gap-1.5">
                        <Button label="Keep it" size="small" severity="secondary" @click="confirming = false" />
                        <Button label="Delete it" size="small" severity="danger" :loading="remove.isPending.value" @click="forget" />
                    </div>
                </div>
                <div v-if="noteError || mutationError" class="border-b border-danger/30 bg-danger/10 px-4 py-2 text-xs text-danger">
                    {{ noteError ?? mutationError }}
                </div>
            </template>

            <p v-if="isLoading && draft === undefined" class="px-4 py-6 text-xs text-subtle">Loading…</p>

            <template v-else>
                <NoteGraph v-if="view === `map` && draft === undefined" :path="path" @open="emit(`open`, $event)" />

                <CodeField
                    v-else-if="view === `source` || draft !== undefined"
                    v-model="source"
                    lang="markdown"
                    :readonly="draft === undefined"
                    aria-label="Note source"
                    @keydown.ctrl.s.prevent="saveDraft"
                    @keydown.meta.s.prevent="saveDraft"
                    @keydown.esc="cancelEdit"
                />

                <template v-else>
                    <!-- The header's plain facts, above the prose: these are what somebody came to look up.
                         Padded by a wrapper rather than by the table, because horizontal padding on a <table>
                         does not indent its cells — the labels sat flush against the panel's edge. -->
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
                    <p v-else class="px-5 py-4 text-xs text-subtle">No text yet — this note is its header.</p>
                </template>
            </template>
        </Panel>

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
                    <span v-else class="text-subtle underline decoration-dotted underline-offset-2" :title="`No note for “${link.title}” yet`">
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
