<script setup lang="ts">
import type { DerivedDiff, DerivedSide, DiffSourceQuery } from "@intentic/sandbox-contract";
import { Button } from "@intentic/ui";
import { errorMessage } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed, onUnmounted, ref, watch } from "vue";
import { formatElapsed } from "../../agents/fleet/agentStatus";
import { isSpreadsheetPath } from "../explorer/fileType";
import { readDerivedDiff } from "./derivedDiff";
import ProseDiffView from "./ProseDiffView.vue";
import { sheetsOfMarkdown } from "./tableDiff";
import TableDiffView from "./TableDiffView.vue";

// A document's change read as tracked changes over the text the sandbox renders from each version: the same
// rendering an agent reads instead of the bytes, so what is compared here is what the agent worked from. Formatting,
// pictures and layout never reach this text, which the bar says outright; the toolbar's Before / After reading is
// where those are looked at.

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
const now = ref(0);
let ticker: ReturnType<typeof setInterval> | undefined;
const startClock = (): void => {
    busySince.value = Date.now();
    now.value = busySince.value;
    ticker ??= setInterval(() => (now.value = Date.now()), 250);
};
const stopClock = (): void => {
    clearInterval(ticker);
    ticker = undefined;
};
onUnmounted(stopClock);
const waited = computed(() => (busySince.value === 0 ? `` : formatElapsed(busySince.value, now.value)));
// Past this, the wait is long enough that a reader wants to know they are allowed to walk away from it.
const longWait = computed(() => now.value - busySince.value >= 20_000);

let seq = 0;
const load = (): void => {
    const id = ++seq;
    loading.value = true;
    error.value = undefined;
    result.value = undefined;
    startClock();
    readDerivedDiff(source, at).then(
        (answer) => {
            if (id !== seq) {
                return;
            }
            result.value = answer;
            loading.value = false;
            stopClock();
        },
        (err: unknown) => {
            if (id !== seq) {
                return;
            }
            loading.value = false;
            stopClock();
            error.value = errorMessage(err, t(`workspace.derivedDiffView.couldNotRenderVersions`));
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
const sideName = (label: "before" | "after"): string => (label === `before` ? t(`workspace.derivedDiffView.sideBefore`) : t(`workspace.derivedDiffView.sideAfter`));

// Whether both versions exist and their text is one and the same: the case the whole pane must call out, since a
// reviewer looking at no marks would otherwise read "nothing changed" over a file that did.
const identical = computed(() => result.value?.before?.present === true && result.value.after?.present === true && before.value === after.value);

const deriver = computed(() => {
    const side = result.value?.after?.present === true ? result.value.after : result.value?.before?.present === true ? result.value.before : undefined;
    return side?.deriver;
});
// Every cap and degradation either conversion hit, once each.
const notes = computed(() => [...new Set([result.value?.before, result.value?.after].flatMap((side) => (side?.present === true ? side.notes : [])))]);
const truncated = computed(() => [result.value?.before, result.value?.after].some((side) => side?.present === true && side.truncated));

// A spreadsheet's rendering is one table per sheet, compared as a grid of cells rather than as paragraphs.
const grid = computed(() => isSpreadsheetPath(path));
const beforeSheets = computed(() => sheetsOfMarkdown(before.value));
const afterSheets = computed(() => sheetsOfMarkdown(after.value));

// Paragraphs (or rows) the diff marked, stated in the bar so a reviewer knows the size of the change before scrolling.
const changed = ref(0);
const changedLabel = computed(() => {
    if (changed.value === 0) {
        return ``;
    }
    const count = changed.value;
    return grid.value ? t(`workspace.derivedDiffView.rowsChanged`, { count }, count) : t(`workspace.derivedDiffView.paragraphsChanged`, { count }, count);
});

const filename = computed(() => path.slice(path.lastIndexOf(`/`) + 1));
</script>

<template>
    <div class="flex h-full min-h-0 flex-col">
        <template v-if="result !== undefined">
<!-- Provenance first: this is not the file, it is the text made from it, and what that text cannot carry. -->
            <div class="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-line px-3 py-1.5 text-2xs text-muted">
                <Icon name="robot" class="shrink-0 text-[0.7rem]" />
                <span class="shrink-0" v-tooltip.bottom="t(`workspace.derivedDiffView.notFileItselfBothVersions`)">
                    {{ t(`workspace.derivedDiffView.textOfBothVersions`) }}
                </span>
                <span v-if="deriver" class="shrink-0 text-subtle">{{ deriver }}</span>
                <span class="shrink-0 text-subtle">{{ t(`workspace.derivedDiffView.formattingNotShown`) }}</span>
                <span v-if="changedLabel" class="shrink-0 tabular-nums text-content">{{ changedLabel }}</span>
                <span class="flex-1"></span>
                <Button size="small" severity="secondary" :text="true" class="shrink-0" @click="emit(`sides`)" v-tooltip.bottom="t(`workspace.diffToolbar.bothVersionsDrawnWhole`)">
                    <Icon name="split-columns" class="text-[0.7rem]" /> {{ t(`workspace.diffToolbar.beforeAfter`) }}
                </Button>
            </div>
            <!-- The one verdict a reviewer must not have to infer from an absence of marks. -->
            <div v-if="identical" class="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5 text-2xs text-muted">
                <Icon name="info-circle" class="shrink-0 text-[0.7rem]" />
                <span>{{ t(`workspace.derivedDiffView.textSameInBothVersions`) }}</span>
            </div>
            <div v-if="truncated" class="flex shrink-0 items-center gap-2 border-b border-warning/40 bg-warning/10 px-3 py-1.5 text-2xs text-warning">
                <Icon name="exclamation-triangle" class="shrink-0 text-[0.7rem]" />
                <span>{{ t(`workspace.derivedDiffView.longDocumentOnlyStart`) }}</span>
            </div>
<!-- Every cap and degradation the conversions hit, shown rather than stored: a dropped style is a change this cannot see. -->
            <ul v-if="notes.length > 0" class="shrink-0 space-y-0.5 border-b border-line bg-overlay px-3 py-1.5 text-2xs text-muted">
                <li v-for="note of notes" :key="note" class="flex items-start gap-2">
                    <Icon name="info-circle" class="mt-px shrink-0 text-[0.7rem]" />
                    <span>{{ note }}</span>
                </li>
            </ul>

            <!-- A side nothing could read: said against that side, with the other reading one press away. -->
            <div v-if="unreadable.length > 0" class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
                <Icon name="box" class="text-3xl text-subtle" />
                <p v-for="side of unreadable" :key="side.label" class="max-w-md text-sm text-muted">
                    {{
                        t(`workspace.derivedDiffView.versionCouldNotBeRead`, { side: sideName(side.label), filename, reason: side.reason })
                    }}
                </p>
                <Button severity="secondary" @click="emit(`sides`)">
                    <Icon name="split-columns" class="text-xs" />
                    {{ t(`workspace.derivedDiffView.showBothVersionsInstead`) }}
                </Button>
            </div>
            <TableDiffView v-else-if="readable && grid" class="min-h-0 flex-1" :before="beforeSheets" :after="afterSheets" @changed="(count) => (changed = count)" />
            <ProseDiffView
                v-else-if="readable"
                class="min-h-0 flex-1"
                :before="before"
                :after="after"
                :unchanged-note="identical ? false : t(`workspace.derivedDiffView.textDiffersOnlySpacing`)"
                @changed="(count) => (changed = count)"
            />
        </template>

        <!-- A wait that can legitimately run for a minute is indistinguishable from a failure without a clock. -->
        <div v-else-if="loading" class="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-muted">
            <Icon name="spinner" class="text-xl" spin />
            <p class="text-sm">{{ t(`workspace.derivedDiffView.renderingBothVersions`) }}</p>
            <p class="max-w-sm text-2xs text-subtle">{{ t(`workspace.derivedDiffView.versionAlreadyRenderedCostsNothing`) }}</p>
            <p class="text-2xs tabular-nums text-subtle">{{ waited }}</p>
            <p v-if="longWait" class="max-w-sm text-2xs text-subtle">{{ t(`workspace.derivedDiffView.stillGoingNothingFailed`) }}</p>
        </div>

        <div v-else-if="error" class="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <Icon name="exclamation-triangle" class="text-3xl text-danger" />
            <p class="max-w-md text-sm text-danger">{{ error }}</p>
            <div class="flex items-center gap-2">
                <Button severity="secondary" @click="load()">
                    <Icon name="refresh" class="text-xs" />
                    {{ t(`ui.action.tryAgain`) }}
                </Button>
                <Button severity="secondary" @click="emit(`sides`)">
                    <Icon name="split-columns" class="text-xs" />
                    {{ t(`workspace.derivedDiffView.showBothVersionsInstead`) }}
                </Button>
            </div>
        </div>
    </div>
</template>
