<script setup lang="ts">
import { ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref, watch } from "vue";
import { type CellDiff, foldUnchangedRows, MAX_ROWS, type RowDiff, type Sheet, type SheetDiff, tableDiff } from "./tableDiff";

// Two versions of tabular data drawn as one grid per sheet: a changed cell shows what it was and what it became, a
// row or a sheet added or dropped wears its mark whole, long unchanged stretches fold to a line. What a spreadsheet's
// rendered text and a csv read as instead of a line diff.

const { before, after } = defineProps<{ before: readonly Sheet[]; after: readonly Sheet[] }>();
// How many rows differ across every sheet, for a host that states it in its own bar.
const emit = defineEmits<{ changed: [number] }>();

const t = useT();

const sheets = computed(() => tableDiff(before, after));
const changed = computed(() => sheets.value.reduce((sum, sheet) => sum + sheet.changedRows, 0));
watch(changed, (count) => emit(`changed`, count), { immediate: true });

// Folds the reader has opened, keyed by sheet and the index of the first row they hide; a new diff starts folded.
const opened = ref<ReadonlySet<string>>(new Set());
const open = (sheet: string, at: number): void => {
    opened.value = new Set([...opened.value, `${sheet}:${at}`]);
};
const runsOf = (sheet: SheetDiff) => foldUnchangedRows(sheet.rows);

// Whether a side was cut before diffing; the count the reader sees is then of the start of the sheet only.
const cut = computed(() => [...before, ...after].some((sheet) => sheet.rows.length > MAX_ROWS));

const ROW_CLASS: Record<RowDiff["kind"], string> = {
    same: ``,
    changed: `bg-warning/5`,
    added: `bg-success/10`,
    removed: `bg-danger/10`,
};
const MARK_CLASS: Record<RowDiff["kind"], string> = {
    same: `border-l-2 border-transparent`,
    changed: `border-l-2 border-warning/60`,
    added: `border-l-2 border-success/60`,
    removed: `border-l-2 border-danger/60`,
};
const sheetBadge = (kind: SheetDiff["kind"]): string | undefined =>
    kind === `added` ? t(`workspace.tableDiffView.newSheet`) : kind === `removed` ? t(`workspace.tableDiffView.sheetRemoved`) : undefined;

// A cell's one text where it has one; a changed cell is drawn as both by the template.
const plain = (cell: CellDiff): string => cell.after ?? cell.before ?? ``;
</script>

<template>
    <div class="ui-softscroll h-full min-h-0 overflow-auto px-4 py-3">
        <p v-if="cut" class="mb-3 text-2xs text-warning">{{ t(`workspace.tableDiffView.longTableOnlyFirstRows`, { rows: MAX_ROWS.toLocaleString() }) }}</p>
        <p v-if="sheets.length === 0" class="text-2xs text-subtle">{{ t(`workspace.tableDiffView.neitherVersionHoldsTable`) }}</p>
        <section v-for="sheet of sheets" :key="sheet.name" class="mb-6 last:mb-0">
            <header class="mb-1.5 flex items-baseline gap-2">
                <h3 class="text-sm font-semibold text-content" :class="sheet.kind === `removed` ? `line-through text-muted` : ``">{{ sheet.name }}</h3>
                <span v-if="sheetBadge(sheet.kind)" class="text-2xs" :class="sheet.kind === `added` ? `text-success` : `text-danger`">{{ sheetBadge(sheet.kind) }}</span>
                <span v-else-if="sheet.kind === `changed`" class="text-2xs tabular-nums text-muted">
                    {{ t(`workspace.tableDiffView.rowsChanged`, { count: sheet.changedRows }, sheet.changedRows) }}
                </span>
                <span v-else class="text-2xs text-subtle">{{ t(`workspace.tableDiffView.unchanged`) }}</span>
            </header>
            <p v-if="sheet.rows.length === 0" class="text-2xs text-subtle">{{ t(`workspace.tableDiffView.emptySheet`) }}</p>
            <div v-else class="overflow-x-auto rounded-md border border-line">
                <table class="w-max min-w-full border-collapse text-xs">
                    <tbody>
                        <template v-for="(run, index) of runsOf(sheet)" :key="index">
                            <!-- A fold spans the whole width: one line for the rows it stands for, opened in place. -->
                            <template v-if="run.kind === `fold`">
                                <template v-if="opened.has(`${sheet.name}:${run.at}`)">
                                    <tr v-for="row of sheet.rows.slice(run.at, run.at + run.count)" :key="`${row.beforeLine}-${row.afterLine}`" class="text-muted">
                                        <td class="border-l-2 border-transparent px-1.5 py-0.5 text-right tabular-nums text-2xs text-subtle">{{ row.afterLine ?? row.beforeLine }}</td>
                                        <td v-for="(cell, column) of row.cells" :key="column" class="border-t border-line/60 px-2 py-0.5 whitespace-pre-wrap">{{ plain(cell) }}</td>
                                    </tr>
                                </template>
                                <tr v-else>
                                    <td :colspan="sheet.columns + 1" class="border-t border-line/60 px-2 py-0.5">
                                        <button type="button" :class="ui.textAction(`text-2xs italic text-subtle`)" @click="open(sheet.name, run.at)">
                                            {{ t(`workspace.tableDiffView.unchangedRows`, { count: run.count }, run.count) }}
                                        </button>
                                    </td>
                                </tr>
                            </template>
                            <!-- Row 0 is the header wherever the source has one: drawn bold, still diffed like any row. -->
                            <tr v-else :class="[ROW_CLASS[run.row.kind], run.row.kind === `same` ? `text-muted` : `text-content`, index === 0 ? `font-semibold` : ``]">
<!-- The row's number in the new version, or the old one's struck through when it is gone; the mark on the margin says which. -->
                                <td class="px-1.5 py-0.5 text-right tabular-nums text-2xs text-subtle" :class="MARK_CLASS[run.row.kind]">
                                    <del v-if="run.row.kind === `removed`" class="line-through decoration-danger/70">{{ run.row.beforeLine }}</del>
                                    <template v-else>{{ run.row.afterLine }}</template>
                                </td>
                                <td v-for="(cell, column) of run.row.cells" :key="column" class="border-t border-line/60 px-2 py-0.5 whitespace-pre-wrap align-top">
                                    <template v-if="cell.kind === `changed`">
                                        <del class="rounded-sm bg-danger/10 text-muted line-through decoration-danger/70">{{ cell.before }}</del>
                                        <span class="mx-1 text-subtle">→</span>
                                        <ins class="rounded-sm bg-success/15 text-content no-underline decoration-success underline decoration-2 underline-offset-2">{{ cell.after }}</ins>
                                    </template>
                                    <ins v-else-if="cell.kind === `added` && run.row.kind === `changed`" class="rounded-sm bg-success/15 no-underline decoration-success underline decoration-2 underline-offset-2">{{ cell.after }}</ins>
                                    <del v-else-if="cell.kind === `removed` && run.row.kind === `changed`" class="rounded-sm bg-danger/10 text-muted line-through decoration-danger/70">{{ cell.before }}</del>
                                    <del v-else-if="run.row.kind === `removed`" class="line-through decoration-danger/70">{{ plain(cell) }}</del>
                                    <template v-else>{{ plain(cell) }}</template>
                                </td>
                                <!-- Pads a short row so the grid's right edge stays straight. -->
                                <td v-for="pad of Math.max(0, sheet.columns - run.row.cells.length)" :key="`pad-${pad}`" class="border-t border-line/60"></td>
                            </tr>
                        </template>
                    </tbody>
                </table>
            </div>
        </section>
    </div>
</template>
