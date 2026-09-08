<script setup lang="ts">
import {
    Button,
    ui,
    FilterBar,
    Icon,
    InfoHint,
    Notice,
    noticeOf,
    Picker,
    type NoticeModel,
    type PickerOptions,
    useKeyedDraft,
    useNarrow,
    useScrollReset,
    useStickyTop,
} from "@intentic/extension-ui";
import { computed, ref, watch } from "vue";
import { filterOptions, type Filters, useNoteMutations, useOverview, useSearch } from "./useKnowledge";
import NoteIndex from "./NoteIndex.vue";
import KnowledgePane from "./KnowledgePane.vue";

// The owner's knowledge base: notes and the graph they form. Search is the only navigation, since every other way in
// (kind, tag, what links here) is the same query with a filter. A hub section (no page title or frame of its own); the
// page scrolls, not the panes, so only the search bar, index, and note identity stay pinned.

// Measured on this element's own width, not the screen's, since a draggable chat panel changes what's left.
const body = ref<HTMLElement | undefined>(undefined);
const stacked = useNarrow(body, 36);

// Publishes `--pinned-top`, the bar's real height, since it wraps and can't be a fixed constant.
const chrome = ref<HTMLElement | undefined>(undefined);
const pinned = useStickyTop(chrome);

const { overview, error: overviewError } = useOverview();

const q = ref(``);
const type = ref<string>();
const tag = ref<string>();
const linkedTo = ref<string>();
const filters = computed<Filters>(() => ({ q: q.value, type: type.value, tag: tag.value, linkedTo: linkedTo.value }));
const filtered = computed(() => q.value !== `` || type.value !== undefined || tag.value !== undefined || linkedTo.value !== undefined);

const { hits, error: searchError, isLoading, isFetching } = useSearch(filters);

const options = computed(() => filterOptions(overview.value));
const pickerOptions = (values: readonly string[], all: string): PickerOptions => [
    { options: [{ value: ``, label: all }, ...values.map((value) => ({ value, label: value }))] },
];
// Pickers can't hold undefined for "no filter", only ""; converted here once, not per consumer.
const typeChoice = computed<string>({ get: () => type.value ?? ``, set: (value) => (type.value = value === `` ? undefined : value) });
const tagChoice = computed<string>({ get: () => tag.value ?? ``, set: (value) => (tag.value = value === `` ? undefined : value) });

const selected = ref<string>();
const { draft } = useKeyedDraft(selected);

// Resets the page scroll on note change; unlike an old per-pane scroller, the page's scrollport outlives it.
useScrollReset(body, () => selected.value);

// Opens the first hit so the pane is never empty; follows the list when the selection drops out of it (typing).
watch(hits, () => {
    if (selected.value === undefined || !hits.value.some((hit) => hit.path === selected.value)) {
        selected.value = hits.value[0]?.path;
    }
});

// Opens the note without disturbing the search behind it; the list is where the reader came from, and moving it would
// lose their place.
const open = (path: string): void => {
    selected.value = path;
};

// Walks the ranked hits without leaving the search field, moving the selection itself (no separate highlight to keep in
// sync). Clamps rather than wraps: past the last hit isn't a meaningful place to land.
const step = (delta: number): void => {
    const paths = hits.value.map((hit) => hit.path);
    if (paths.length === 0) {
        return;
    }
    const at = selected.value === undefined ? -1 : paths.indexOf(selected.value);
    selected.value = paths[Math.min(paths.length - 1, Math.max(0, at + delta))];
};

// Re-aims the list at everything linking to this note; clears the other filters instead of compounding, since this
// replaces the query.
const showLinked = (path: string): void => {
    q.value = ``;
    type.value = undefined;
    tag.value = undefined;
    linkedTo.value = path;
};

const clearFilters = (): void => {
    q.value = ``;
    type.value = undefined;
    tag.value = undefined;
    linkedTo.value = undefined;
};
watch(q, () => (linkedTo.value = undefined));

const linkedToTitle = computed(() => hits.value.find((hit) => hit.path === linkedTo.value)?.title ?? linkedTo.value);

// A `<Notice>`, not a hand-rolled strip, so tone and layout can't drift; `info` since neither needs action.
const linkedNotice = computed<NoticeModel | undefined>(() =>
    linkedTo.value === undefined
        ? undefined
        : { tone: `info`, title: `Everything linking to "${linkedToTitle.value}"`, action: { label: `Show everything`, run: clearFilters } },
);

// One line, only when something's unfinished; no action button, since nothing here is fixed by a click.
const health = computed<NoticeModel | undefined>(() => {
    const report = overview.value;
    if (report === undefined) {
        return undefined;
    }
    const drift = report.typeDrift.length + report.relationDrift.length;
    const lines = [
        report.broken.length === 0
            ? undefined
            : `${report.broken.length} ${report.broken.length === 1 ? `link points` : `links point`} at notes nobody has written`,
        drift === 0 ? undefined : `${drift} ${drift === 1 ? `word is` : `words are`} not in the vocabulary yet`,
        report.orphans.length === 0
            ? undefined
            : `${report.orphans.length} ${report.orphans.length === 1 ? `note is` : `notes are`} connected to nothing`,
        report.unreadable.length === 0
            ? undefined
            : `${report.unreadable.length} ${report.unreadable.length === 1 ? `note has` : `notes have`} a header this reader could not parse`,
    ].filter((line) => line !== undefined);
    return lines.length === 0 ? undefined : { tone: `info`, title: lines.join(` · `), detail: `The agent's kb check lists them in full.` };
});

const error = computed(() => overviewError.value ?? searchError.value);

// Writes one seed note (the vocabulary) and opens it, not example content that would need cleaning up before the
// knowledge base said anything true.
const { seed } = useNoteMutations();
const startKnowledge = async (): Promise<void> => {
    const { written } = await seed.mutateAsync();
    selected.value = written[0] ?? selected.value;
};
</script>

<template>
    <!-- A hub section body: no header or frame of its own (the hub draws both); as tall as its note, not clamped. -->
    <div ref="body" class="flex flex-col gap-3" :style="pinned.style.value">
        <Notice v-if="error" :of="noticeOf(error)" />

        <!-- Pinned, since search is the only route to another note here; `pb-3 -mb-3` paints the gutter, spacing kept. -->
        <div ref="chrome" class="sticky top-0 z-1 -mb-3 bg-canvas pb-3">
            <FilterBar
                v-model="q"
                placeholder="Search the knowledge base…"
                aria-label="Search the knowledge base"
                clearable
                :count="hits.length"
                :busy="isFetching && !isLoading"
                @keydown.down.prevent="step(1)"
                @keydown.up.prevent="step(-1)"
            >
                <template v-if="options.types.length > 0 || options.tags.length > 0" #controls>
                    <Picker
                        v-if="options.types.length > 0"
                        v-model="typeChoice"
                        variant="ghost"
                        :options="pickerOptions(options.types, `Any kind`)"
                        class="max-w-32"
                        aria-label="Kind"
                        header="Kind"
                    />
                    <Picker
                        v-if="options.tags.length > 0"
                        v-model="tagChoice"
                        variant="ghost"
                        :options="pickerOptions(options.tags, `Any tag`)"
                        class="max-w-32"
                        aria-label="Tag"
                        header="Tag"
                    />
                </template>
                <template #actions>
                    <span v-if="overview" class="text-2xs text-subtle">
                        {{ overview.noteCount }} {{ overview.noteCount === 1 ? `note` : `notes` }} · {{ overview.linkCount }}
                        {{ overview.linkCount === 1 ? `link` : `links` }} · {{ overview.types.length }}
                        {{ overview.types.length === 1 ? `kind` : `kinds` }}
                    </span>
                    <InfoHint label="Knowledge">
                        <span class="block text-sm font-medium text-content">The knowledge base</span>
                        <span class="mt-1 block text-xs text-muted">
                            A folder of markdown notes: <b>{{ overview?.folder ?? `knowledge/` }}</b> in your workspace, where each note is a
                            <i>thing</i>
                            (a person, a project, a decision, a word) and each link is a connection between two of them. The agent reads it before
                            answering questions about your world and writes to it when it learns something durable; you read, correct and delete here.
                            Open it in Obsidian or put it under git: it is only ever markdown.
                        </span>
                    </InfoHint>
                </template>
            </FilterBar>
        </div>

        <!-- Not pinned: both are read-once facts about the whole knowledge base, not worth permanent screen space. -->
        <Notice v-if="linkedNotice" :of="linkedNotice" />
        <Notice v-if="health" :of="health" />

        <div v-if="overview?.noteCount === 0 && !filtered" :class="ui.emptyState(`flex flex-col items-center gap-2 px-6 py-12 text-sm`)">
            <Icon name="sitemap" class="text-base text-subtle" />
            <p class="text-content">Nothing here yet.</p>
            <p class="max-w-md text-xs text-muted">
                Notes appear here as the agent learns durable things about your world, who you work with, what a project is for, what was decided and
                why. Ask it to remember something, or drop your own markdown into
                <b>{{ overview?.folder ?? `knowledge/` }}</b> and it will be read the same way.
            </p>
            <!-- Seeds a vocabulary, not example content nobody asked for. -->
            <Button
                label="Start it off with a vocabulary"
                size="small"
                severity="secondary"
                :loading="seed.isPending.value"
                @click="startKnowledge"
            />
            <p v-if="seed.error.value" class="text-xs text-danger">{{ seed.error.value.message }}</p>
        </div>

        <!-- Unclamped, so the hub page scrolls the note; `items-start` stops the sticky index stretching to its height. -->
        <div v-else class="flex gap-4" :class="stacked ? `flex-col` : `items-start`">
            <!--
                Folds above the note, not beside it, in a narrow body; unframed, like the shared rail. 14rem here (the rail's is 16), since these
                rows fit more per width; sticky, bounded by `--pinned-top`.
            -->
            <div
                class="flex min-w-0 shrink-0 flex-col"
                :class="stacked ? `max-h-56` : `sticky top-(--pinned-top) max-h-[calc(100dvh-var(--pinned-top))] w-56`"
            >
                <NoteIndex :hits="hits" :selected="selected" :filtered="filtered" :is-loading="isLoading" @pick="open" />
            </div>

            <!-- No `:key`: the page's scroll resets instead (useScrollReset), without discarding the pane or an open draft. -->
            <KnowledgePane
                v-if="selected"
                v-model:draft="draft"
                :path="selected"
                class="min-w-0 flex-1"
                @open="open"
                @filter="showLinked"
                @forgotten="selected = undefined"
            />

            <!-- No `min-h-0`: nothing clamps this row, so there's no height for it to shrink below; its own padding sizes it. -->
            <section v-else :class="ui.emptyState(`flex flex-1 flex-col items-center justify-center gap-2 px-6 py-10`)">
                <Icon name="sitemap" class="text-base text-subtle" />
                <p class="text-sm text-muted">Pick a note to read it.</p>
                <p class="max-w-xs text-xs text-subtle">Follow its links to move through your knowledge the way the agent does.</p>
            </section>
        </div>
    </div>
</template>
