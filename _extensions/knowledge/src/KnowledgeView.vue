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
    useNarrow,
} from "@intentic/extension-ui";
import { computed, ref, watch } from "vue";
import { filterOptions, type Filters, useNoteMutations, useOverview, useSearch } from "./useKnowledge";
import NoteIndex from "./NoteIndex.vue";
import KnowledgePane from "./KnowledgePane.vue";

/* THE KNOWLEDGE SECTION — the owner's knowledge base: notes about the world this work happens in, and the graph
 * those notes already form.
 *
 * SEARCH IS THE NAVIGATION. There is no tree of folders here and deliberately so: a knowledge base is reached
 * by asking it something, and every other way in (by kind, by tag, by what links to a thing) is the same query
 * with a filter set rather than a different screen. One route answers all of them, so the list can never
 * disagree with itself about what the knowledge base holds.
 *
 * A HUB SECTION, so this file draws neither a page title nor a frame — the hub draws both. That constraint is
 * what shapes the layout: the section is a wide band rather than a page, so the chrome is one row, the index is
 * a narrow column beside the note rather than a second rail in front of it, and in a narrow body it folds above
 * the note instead of hiding it.
 *
 * WHAT IS UNFINISHED ABOUT THE KNOWLEDGE BASE gets a strip, and only when there IS something — links pointing at notes
 * nobody wrote, kinds the vocabulary has not adopted, notes that fell out of the graph. A permanent panel
 * reading "0 problems" would spend the same space to say nothing, and would train the reader to stop looking at
 * the place where the real thing eventually appears. */

/* MEASURED ON THIS BODY, not on the screen and not on the hub. The section sits inside a hub, inside the
 * workspace pane, beside a chat panel the reader can drag — so by the time a note gets here the width left is
 * nothing the window can predict. Below ~36rem a 16rem index beside a note leaves neither readable. */
const body = ref<HTMLElement | undefined>(undefined);
const stacked = useNarrow(body, 36);
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
// The pickers speak "" for "no filter" because a Picker always holds one of its options; the queries speak
// undefined. One conversion, here, rather than a special case in every consumer.
const typeChoice = computed<string>({ get: () => type.value ?? ``, set: (value) => (type.value = value === `` ? undefined : value) });
const tagChoice = computed<string>({ get: () => tag.value ?? ``, set: (value) => (tag.value = value === `` ? undefined : value) });

const selected = ref<string>();
/* Unsaved edits, keyed by note. Held here, above the pane, because the pane is REUSED as the selection moves —
 * without this, opening a linked note to check a fact would silently drop the correction being written. */
const drafts = ref(new Map<string, string>());
const draft = computed<string | undefined>({
    get: () => (selected.value === undefined ? undefined : drafts.value.get(selected.value)),
    set: (value) => {
        if (selected.value === undefined) {
            return;
        }
        if (value === undefined) {
            drafts.value.delete(selected.value);
        } else {
            drafts.value.set(selected.value, value);
        }
    },
});

// Open on the first answer, so the section is never a list with an empty half beside it — and follow the list
// when what is selected drops out of it, which is what happens as somebody types.
watch(hits, () => {
    if (selected.value === undefined || !hits.value.some((hit) => hit.path === selected.value)) {
        selected.value = hits.value[0]?.path;
    }
});

// Following a link opens the note WITHOUT disturbing the search behind it: the list is where the reader came
// from, and yanking it to the new note would lose their place in an answer they are working through.
const open = (path: string): void => {
    selected.value = path;
};

// "Show these in the list" — re-aim the list at everything linking to the open note. The one navigation that
// genuinely replaces the query, so it clears the rest of the filters rather than compounding with them.
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

/* THE TWO STANDING FACTS THIS SECTION REPORTS ARE <Notice>S, not strips of its own. Both were hand-rolled
 * bordered rows — one for "the list is aimed at a note's neighbours", one for "there are loose ends" — and
 * a hand-rolled strip is the first thing to disagree with the app about tone, weight and where the way out
 * sits. `info` is the tone for a fact the reader may want and never has to act on, which is what both are. */
const linkedNotice = computed<NoticeModel | undefined>(() =>
    linkedTo.value === undefined
        ? undefined
        : { tone: `info`, title: `Everything linking to “${linkedToTitle.value}”`, action: { label: `Show everything`, run: clearFilters } },
);

/* The one-line report on what is unfinished, and only when there IS something. Ordered by what a reader can
 * actually act on: an unwritten note is an invitation, a drifting word is a decision to make, an orphan is
 * knowledge that has fallen out of reach.
 *
 * NO ACTION, deliberately: nothing here is fixed by a button, and offering one would promise it is. The cause
 * line names the command that lists them instead. */
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

/* Starting it off writes ONE note — the vocabulary — and opens it. Not a folder of example people: a
 * knowledge base seeded with facts about nobody has to be emptied before it can say anything true. What a new
 * knowledge base actually lacks is the handful of words it is going to use, which is also the one thing the owner and
 * the agent cannot each guess at consistently on their own. */
const { seed } = useNoteMutations();
const startKnowledge = async (): Promise<void> => {
    const { written } = await seed.mutateAsync();
    selected.value = written[0] ?? selected.value;
};
</script>

<template>
    <!-- A HUB SECTION BODY — no page header and no frame of its own: the hub draws both. -->
    <div ref="body" class="flex min-h-0 flex-col gap-3">
        <Notice v-if="error" :of="noticeOf(error)" />

        <!-- The section's one row of chrome, and it is the app's <FilterBar>: free text on the left taking the
             row's slack, the controls that narrow the same list in their own matched track, and what does not
             narrow anything sitting chromeless beside them. The field spanning the row is the point — the bar
             then shares its left and right edges with the two panes under it, instead of huddling in a corner
             above them. The pickers are `ghost` because the track is already the box. -->
        <FilterBar
            v-model="q"
            placeholder="Search the knowledge base…"
            aria-label="Search the knowledge base"
            clearable
            :count="hits.length"
            :busy="isFetching && !isLoading"
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
                        A folder of markdown notes — <b>{{ overview?.folder ?? `knowledge/` }}</b> in your workspace — where each note is a
                        <i>thing</i>
                        (a person, a project, a decision, a word) and each link is a connection between two of them. The agent reads it before
                        answering questions about your world and writes to it when it learns something durable; you read, correct and delete here.
                        Open it in Obsidian or put it under git — it is only ever markdown.
                    </span>
                </InfoHint>
            </template>
        </FilterBar>

        <Notice v-if="linkedNotice" :of="linkedNotice" />
        <Notice v-if="health" :of="health" />

        <!-- Bounded, so the two panes scroll inside their own frames and the chrome above stays put. Unbounded,
             the hub page would scroll them together and reaching the end of a long note would take the way to
             the next one off screen with it. -->
        <div v-if="overview?.noteCount === 0 && !filtered" :class="ui.emptyState(`flex flex-col items-center gap-2 px-6 py-12 text-sm`)">
            <Icon name="sitemap" class="text-base text-subtle" />
            <p class="text-content">Nothing here yet.</p>
            <p class="max-w-md text-xs text-muted">
                Notes appear here as the agent learns durable things about your world — who you work with, what a project is for, what was decided and
                why. Ask it to remember something, or drop your own markdown into
                <b>{{ overview?.folder ?? `knowledge/` }}</b> and it will be read the same way.
            </p>
            <!-- One note, not a folder of example people: what a new knowledge base lacks is the handful of words it is
                 going to use, and that is the one thing neither side can guess at consistently alone. -->
            <Button
                label="Start it off with a vocabulary"
                size="small"
                severity="secondary"
                :loading="seed.isPending.value"
                @click="startKnowledge"
            />
            <p v-if="seed.error.value" class="text-xs text-danger">{{ seed.error.value.message }}</p>
        </div>

        <div v-else class="flex max-h-panel-lg min-h-0 gap-4" :class="stacked ? `flex-col` : undefined">
            <!-- In a narrow body the index folds above the note instead of beside it: a 16rem column next to a
                 note leaves neither of them readable, and hiding the note behind a list would put two clicks
                 between the reader and the thing they came for.
                 UNFRAMED, which is the shared rail's rule and not this section's preference: an index is chrome
                 pointing AT something, so a box around it makes it compete with the note it points at. The
                 gutter is what separates the two, at the same 1rem every split screen in the app uses. -->
            <div class="flex min-w-0 shrink-0 flex-col" :class="stacked ? `max-h-56` : `max-h-full w-64`">
                <NoteIndex :hits="hits" :selected="selected" :filtered="filtered" :is-loading="isLoading" @pick="open" />
            </div>

            <KnowledgePane
                v-if="selected"
                :key="selected"
                v-model:draft="draft"
                :path="selected"
                class="min-w-0 flex-1"
                @open="open"
                @filter="showLinked"
                @forgotten="selected = undefined"
            />

            <!-- The same dashed placeholder the empty state above uses, from the same helper — it was spelled
                 out by hand here, two elements away from the call that produces it. -->
            <section v-else :class="ui.emptyState(`flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 py-10`)">
                <Icon name="sitemap" class="text-base text-subtle" />
                <p class="text-sm text-muted">Pick a note to read it.</p>
                <p class="max-w-xs text-xs text-subtle">Follow its links to move through your knowledge the way the agent does.</p>
            </section>
        </div>
    </div>
</template>
