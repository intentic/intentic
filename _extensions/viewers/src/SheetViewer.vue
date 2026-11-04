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
const { loading, error, stale, start, drawn } = useViewerLoad(() => t(`sheetViewer.couldNotRead`));
let client: ReturnType<typeof createSheetWorkerClient> | undefined;

const tabOptions = computed(() => sheets.value.map((name) => ({ label: name, value: name })));
// A spreadsheet's first row is its header far more often than not, and the rest of the grid is ragged: a row
// is only as long as its last filled cell, so the column count has to come from the widest row rather than
// from the first one, or the tail of a wider row would have nowhere to render.
const columnCount = computed(() => activeRows.value.reduce((widest, row) => Math.max(widest, row.length), 0));
const headerRow = computed(() => activeRows.value[0]);
const bodyRows = computed(() => activeRows.value.slice(1));

// Reading one sheet of the workbook already loaded. `keep` is a refresh's: the rows on screen stay until the new ones
// arrive, rather than the grid emptying under the reader.
const readSheet = async (name: string, target: NonNullable<typeof client>, isLatest: () => boolean, keep: boolean): Promise<void> => {
    if (!keep) {
        activeRows.value = [];
    }
    const rows = await target.render(name);
    if (!isLatest()) {
        return;
    }
    active.value = name;
    activeRows.value = rows;
};

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

// A refresh (the workbook rewritten while open) keeps the sheet the reader is on, and the grid on screen, until the new
// workbook has loaded; one that fails to load leaves them as they were (useViewerLoad's `stale`).
const render = (source: Blob): Promise<void> => {
    const refresh = drawn();
    return start(async (isLatest) => {
        if (!refresh) {
            client?.close();
            client = undefined;
            sheets.value = [];
            active.value = ``;
            activeRows.value = [];
        }
        const buffer = await source.arrayBuffer();
        if (!isLatest()) {
            return;
        }
        const { default: SheetWorker } = await import(`./sheetWorker?worker`);
        if (!isLatest()) {
            return;
        }
        const next = createSheetWorkerClient(async () => new SheetWorker());
        let names: readonly string[];
        try {
            names = await next.load(buffer);
        } catch (caught) {
            next.close();
            throw caught;
        }
        if (!isLatest()) {
            next.close();
            return;
        }
        client?.close();
        client = next;
        const shown = refresh && names.includes(active.value) ? active.value : names[0];
        sheets.value = names;
        if (shown !== undefined) {
            await readSheet(shown, next, isLatest, refresh);
        } else {
            active.value = ``;
            activeRows.value = [];
        }
    });
};

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
            <ViewerStatus :loading="loading" :error="error" :stale="stale">
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
