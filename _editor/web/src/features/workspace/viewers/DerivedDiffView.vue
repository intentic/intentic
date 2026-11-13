<script setup lang="ts">
import type { DerivedDiff, DerivedSide, DiffSourceQuery } from "@intentic/sandbox-contract/schemas/diff";
import { Button, EmptyState, formatElapsed, Notice } from "@intentic/ui";
import { messageOr, useLatest, useNow } from "@intentic/ui/async";
import { basename } from "@intentic/ui/path";
import { useT } from "@intentic/ui/i18n";
import { computed, ref, watch } from "vue";
import { formatOf } from "@intentic/ui/file-format";
import ConversionNotes, { type ConversionNote } from "./ConversionNotes.vue";
import { readDerivedDiff } from "./derivedDiff";
import ProseDiffView from "./ProseDiffView.vue";
import { sheetsOfMarkdown } from "./table/tableDiff";
import TableDiffView from "./table/TableDiffView.vue";

// A document's change read as tracked changes over the text the sandbox renders from each version: the same
// rendering an agent reads instead of the bytes, so what is compared here is what the agent worked from. Formatting,
// pictures and layout never reach this text; the diff bar's reading switch (DiffToolbar) names this reading Text, says
// so on its card, and is the way to Before / After where those are looked at. Nothing here repeats that bar: the pane
// opens on the document, with a line of its own only for what a reader must not miss (a cut, a caveat, a verdict).

// `source`: which diff, the same query the byte route takes; `at`: another sandbox's daemon, absent for the active one.
const { path, source, at } = defineProps<{ path: string; source: DiffSourceQuery; at?: string }>();
// The reader wants both versions drawn whole instead; the host switches the reading.
const emit = defineEmits<{ sides: [] }>();

const t = useT();

const result = ref<DerivedDiff>();
const loading = ref(false);
const error = ref<string>();

// A render runs in a child process this pane cannot see into; elapsed time is what tells working from hung.
const busySince = ref(0);
const ticking = ref(false);
const now = useNow(ticking, 250);
const startClock = (): void => {
    busySince.value = Date.now();
    ticking.value = true;
};
const stopClock = (): void => {
    ticking.value = false;
};
// Never below zero: the shared clock may not have ticked since this wait began.
const waitedMs = computed(() => Math.max(0, now.value - busySince.value));
const waited = computed(() => (busySince.value === 0 ? `` : formatElapsed(waitedMs.value / 1000)));
// Past this, the wait is long enough that a reader wants to know they are allowed to walk away from it.
const longWait = computed(() => waitedMs.value >= 20_000);

const latest = useLatest();
const load = (): void => {
    const isLatest = latest();
    loading.value = true;
    error.value = undefined;
    result.value = undefined;
    startClock();
    readDerivedDiff(source, at).then(
        (answer) => {
            if (!isLatest()) {
                return;
            }
            result.value = answer;
            loading.value = false;
            stopClock();
        },
        (err: unknown) => {
            if (!isLatest()) {
                return;
            }
            loading.value = false;
            stopClock();
            error.value = messageOr(err, t(`workspace.derivedDiffView.couldNotRenderVersions`));
        },
    );
};
// Keyed on the query's content: the same object rebuilt for the same diff is not a new diff.
watch(() => [JSON.stringify(source), at] as const, load, { immediate: true });

const text = (side: DerivedSide | undefined): string => (side?.present === true ? side.content : ``);
const before = computed(() => text(result.value?.before));
const after = computed(() => text(result.value?.after));

// Sides the diff has but nothing could read; each is said against its own side.
const unreadable = computed(() =>
    (
        [
            [`before`, result.value?.before],
            [`after`, result.value?.after],
        ] as const
    ).flatMap(([label, side]) => (side?.present === false ? [{ label, reason: side.reason }] : [])),
);
const readable = computed(() => result.value !== undefined && unreadable.value.length === 0);
// The side's name inside the sentence that says it could not be read; two calls, so each key is one the catalog check can see.
const sideName = (label: "before" | "after"): string =>
    label === `before` ? t(`workspace.derivedDiffView.sideBefore`) : t(`workspace.derivedDiffView.sideAfter`);

// Whether both versions exist and their text is one and the same: the case the whole pane must call out, since a
// reviewer looking at no marks would otherwise read "nothing changed" over a file that did.
const identical = computed(() => result.value?.before?.present === true && result.value.after?.present === true && before.value === after.value);

// Every cap and degradation either conversion hit, once each; with two versions rendered, a note only one of them
// hit is tagged with its side.
const notes = computed((): ConversionNote[] => {
    const of = (side: DerivedSide | undefined): readonly string[] => (side?.present === true ? side.notes : []);
    const fromBefore = of(result.value?.before);
    const fromAfter = of(result.value?.after);
    const tagged = result.value?.before?.present === true && result.value.after?.present === true;
    const only = (own: readonly string[], other: readonly string[], side: "before" | "after"): ConversionNote[] =>
        own.filter((note) => !other.includes(note)).map((note) => (tagged ? { text: note, side } : { text: note }));
    return [
        ...fromBefore.filter((note) => fromAfter.includes(note)).map((note): ConversionNote => ({ text: note })),
        ...only(fromBefore, fromAfter, `before`),
        ...only(fromAfter, fromBefore, `after`),
    ];
});
const truncated = computed(() => [result.value?.before, result.value?.after].some((side) => side?.present === true && side.truncated));

// A spreadsheet's rendering is one table per sheet, compared as a grid of cells rather than as paragraphs.
const grid = computed(() => formatOf(path).sheet === true);
const beforeSheets = computed(() => sheetsOfMarkdown(before.value));
const afterSheets = computed(() => sheetsOfMarkdown(after.value));

const filename = computed(() => basename(path));
</script>

<template>
    <div class="flex h-full min-h-0 flex-col">
        <template v-if="result !== undefined">
            <!-- A grid has no lead line of its own, so the one verdict a reviewer must not infer from an absence of marks
                 is a strip over it; prose says it as the document's first line instead (below). -->
            <Notice v-if="identical && grid" tone="info" size="sm" strip>{{ t(`workspace.derivedDiffView.textSameInBothVersions`) }}</Notice>
            <Notice v-if="truncated" tone="warning" size="sm" strip>{{ t(`workspace.derivedDiffView.longDocumentOnlyStart`) }}</Notice>
            <!-- Every cap and degradation the conversions hit, shown rather than stored: a dropped style is a change this cannot see. -->
            <ConversionNotes :notes="notes" />

            <!-- A side nothing could read: said against that side, with the other reading one press away. -->
            <EmptyState v-if="unreadable.length > 0" icon="box" class="min-h-0 flex-1">
                <template #title>
                    <span v-for="side of unreadable" :key="side.label" class="block max-w-md">
                        {{ t(`workspace.derivedDiffView.versionCouldNotBeRead`, { side: sideName(side.label), filename, reason: side.reason }) }}
                    </span>
                </template>
                <template #actions>
                    <Button tier="boring" @click="emit(`sides`)">
                        <Icon name="split-columns" class="text-xs" />
                        {{ t(`workspace.derivedDiffView.showBothVersionsInstead`) }}
                    </Button>
                </template>
            </EmptyState>
            <TableDiffView
                v-else-if="readable && grid"
                class="min-h-0 flex-1"
                :before="beforeSheets"
                :after="afterSheets"
            />
            <ProseDiffView
                v-else-if="readable"
                class="min-h-0 flex-1"
                :before="before"
                :after="after"
                :unchanged-note="identical ? t(`workspace.derivedDiffView.textSameInBothVersions`) : t(`workspace.derivedDiffView.textDiffersOnlySpacing`)"
            />
        </template>

        <!-- A wait that can legitimately run for a minute is indistinguishable from a failure without a clock. -->
        <EmptyState
            v-else-if="loading"
            icon="spinner"
            spin
            role="status"
            :title="t(`workspace.derivedDiffView.renderingBothVersions`)"
            :line="t(`workspace.derivedDiffView.versionAlreadyRenderedCostsNothing`)"
            class="h-full"
        >
            <p class="text-2xs tabular-nums text-subtle">{{ waited }}</p>
            <p v-if="longWait" class="max-w-sm text-2xs text-subtle">{{ t(`workspace.derivedDiffView.stillGoingNothingFailed`) }}</p>
        </EmptyState>

        <EmptyState v-else-if="error" tone="danger" :title="error" class="h-full">
            <template #actions>
                <Button tier="accent" @click="load()">
                    <Icon name="refresh" class="text-xs" />
                    {{ t(`ui.action.tryAgain`) }}
                </Button>
                <Button tier="boring" @click="emit(`sides`)">
                    <Icon name="split-columns" class="text-xs" />
                    {{ t(`workspace.derivedDiffView.showBothVersionsInstead`) }}
                </Button>
            </template>
        </EmptyState>
    </div>
</template>
