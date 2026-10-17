<script setup lang="ts">
import { SegmentedControl } from "@intentic/extension-ui";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { SheetRows } from "./sheetProtocol";
import { createSheetWorkerClient } from "./sheetWorkerClient";
import { t } from "./i18n.js";
import ViewerStatus from "./load/ViewerStatus.vue";
import { useViewerLoad } from "./load/useViewerLoad.js";

/* XLSX preview: transfers a workbook to a dedicated worker, which parses it once and hands back the selected sheet's VALUES. */

const { blob } = defineProps<{ blob: Blob }>();

const sheets = ref<readonly string[]>([]);
const active = ref(``);
const activeRows = ref<SheetRows>([]);
// One sequence for the file and the sheet picked in it: a new file or a new pick each supersedes whatever was still
// loading, so a sheet answered by a workbook since replaced, or a pick since changed, is dropped.
const { loading, error, start } = useViewerLoad(() => t(`sheetViewer.couldNotRead`));
let client: ReturnType<typeof createSheetWorkerClient> | undefined;

const tabOptions = computed(() => sheets.value.map((name) => ({ label: name, value: name })));
// A spreadsheet's first row is its header far more often than not, and the rest of the grid is ragged: a row
// is only as long as its last filled cell, so the column count has to come from the widest row rather than
// from the first one, or the tail of a wider row would have nowhere to render.
const columnCount = computed(() => activeRows.value.reduce((widest, row) => Math.max(widest, row.length), 0));
const headerRow = computed(() => activeRows.value[0]);
const bodyRows = computed(() => activeRows.value.slice(1));

const renderSheet = (name: string, target: NonNullable<typeof client>): Promise<void> =>
    start(async (isLatest) => {
        active.value = name;
        activeRows.value = [];
        const rows = await target.render(name);
        if (!isLatest()) {
            return;
        }
        activeRows.value = rows;
    });

const select = (name: string): void => {
    if (client !== undefined) {
        void renderSheet(name, client);
    }
};

const render = (source: Blob): Promise<void> =>
    start(async (isLatest) => {
        client?.close();
        client = undefined;
        sheets.value = [];
        active.value = ``;
        activeRows.value = [];
        const buffer = await source.arrayBuffer();
        if (!isLatest()) {
            return;
        }
        const { default: SheetWorker } = await import(`./sheetWorker?worker`);
        if (!isLatest()) {
            return;
        }
        const next = createSheetWorkerClient(async () => new SheetWorker());
        client = next;
        const names = await next.load(buffer);
        if (!isLatest()) {
            return;
        }
        sheets.value = names;
        const first = names[0];
        if (first !== undefined) {
            await renderSheet(first, next);
        }
    });

onMounted(() => void render(blob));
watch(
    () => blob,
    (next) => void render(next),
);
onBeforeUnmount(() => client?.close());
</script>

<template>
    <div class="flex h-full min-h-0 flex-col">
        <!-- A workbook's sheets are its parts, so they are tabs, and the strip is the bar: its line is the bar's foot, and it scrolls. -->
        <SegmentedControl
            v-if="sheets.length > 1"
            v-model="active"
            size="xs"
            variant="underline"
            :options="tabOptions"
            class="shrink-0 px-4 pt-1.5"
            @update:model-value="select"
        />
        <div class="min-h-0 flex-1">
            <ViewerStatus :loading="loading" :error="error">
                <div v-if="columnCount === 0" class="flex h-full items-center justify-center text-sm text-muted">
                    {{ t(`sheetViewer.sheetEmpty`) }}
                </div>
                <div v-else class="xlsx-sheet h-full overflow-auto p-4">
                    <table>
                        <thead v-if="headerRow !== undefined">
                            <tr>
                                <th v-for="column in columnCount" :key="column" :class="{ numeric: typeof headerRow[column - 1] === `number` }">
                                    {{ headerRow[column - 1] }}
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="(row, index) in bodyRows" :key="index">
                                <td v-for="column in columnCount" :key="column" :class="{ numeric: typeof row[column - 1] === `number` }">
                                    {{ row[column - 1] }}
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </ViewerStatus>
        </div>
    </div>
</template>

<style scoped>
.xlsx-sheet table {
    border-collapse: collapse;
    font-size: 0.8125rem;
}
.xlsx-sheet td,
.xlsx-sheet th {
    border: 1px solid var(--color-line);
    padding: 0.3rem 0.55rem;
    text-align: left;
    white-space: nowrap;
}
/* Numbers read as a column when they share an edge; text does not. */
.xlsx-sheet td.numeric,
.xlsx-sheet th.numeric {
    text-align: right;
    font-variant-numeric: tabular-nums;
}
.xlsx-sheet th {
    background: var(--color-card);
    font-weight: 600;
}
</style>
