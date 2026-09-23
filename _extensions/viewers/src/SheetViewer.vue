<script setup lang="ts">
import { Icon, SegmentedControl, useLatest } from "@intentic/extension-ui";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { SheetRows } from "./sheetProtocol";
import { createSheetWorkerClient } from "./sheetWorkerClient";
import { t } from "./i18n.js";

/* XLSX preview: transfers a workbook to a dedicated worker, which parses it once and hands back the selected sheet's VALUES. */

const { blob } = defineProps<{ blob: Blob }>();

const sheets = ref<readonly string[]>([]);
const active = ref(``);
const activeRows = ref<SheetRows>([]);
const loading = ref(true);
const error = ref<string>();
const latestFile = useLatest();
const latestSheet = useLatest();
let client: ReturnType<typeof createSheetWorkerClient> | undefined;

const tabOptions = computed(() => sheets.value.map((name) => ({ label: name, value: name })));
// A spreadsheet's first row is its header far more often than not, and the rest of the grid is ragged: a row
// is only as long as its last filled cell, so the column count has to come from the widest row rather than
// from the first one, or the tail of a wider row would have nowhere to render.
const columnCount = computed(() => activeRows.value.reduce((widest, row) => Math.max(widest, row.length), 0));
const headerRow = computed(() => activeRows.value[0]);
const bodyRows = computed(() => activeRows.value.slice(1));

// A sheet rendered for a workbook since replaced is dropped too: every load swaps `client` first.
const renderSheet = async (name: string, target: NonNullable<typeof client>): Promise<void> => {
    const isLatest = latestSheet();
    active.value = name;
    activeRows.value = [];
    loading.value = true;
    error.value = undefined;
    try {
        const rows = await target.render(name);
        if (!isLatest() || target !== client) {
            return;
        }
        activeRows.value = rows;
    } catch (caught) {
        if (!isLatest() || target !== client) {
            return;
        }
        error.value = caught instanceof Error ? caught.message : `Could not read this spreadsheet.`;
    } finally {
        if (isLatest() && target === client) {
            loading.value = false;
        }
    }
};

const select = (name: string): void => {
    if (client !== undefined) {
        void renderSheet(name, client);
    }
};

const render = async (source: Blob): Promise<void> => {
    const isLatest = latestFile();
    client?.close();
    client = undefined;
    loading.value = true;
    error.value = undefined;
    sheets.value = [];
    active.value = ``;
    activeRows.value = [];
    try {
        const buffer = await source.arrayBuffer();
        if (!isLatest()) {
            return;
        }
        const { default: SheetWorker } = await import(`./sheetWorker?worker`);
        if (!isLatest()) {
            return;
        }
        const next = createSheetWorkerClient(new SheetWorker());
        client = next;
        const names = await next.load(buffer);
        if (!isLatest() || next !== client) {
            return;
        }
        sheets.value = names;
        const first = names[0];
        if (first === undefined) {
            loading.value = false;
            return;
        }
        await renderSheet(first, next);
    } catch (caught) {
        if (!isLatest()) {
            return;
        }
        error.value = caught instanceof Error ? caught.message : `Could not read this spreadsheet.`;
        loading.value = false;
    }
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
        <div v-if="sheets.length > 1" class="flex shrink-0 items-center overflow-x-auto border-b border-line-subtle px-2 py-1.5">
            <SegmentedControl v-model="active" size="xs" :options="tabOptions" @update:model-value="select" />
        </div>
        <div class="min-h-0 flex-1">
            <div v-if="loading" class="flex h-full items-center justify-center text-muted"><Icon name="spinner" class="text-xl" spin /></div>
            <div v-else-if="error" class="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                <Icon name="exclamation-triangle" class="text-3xl text-danger" />
                <p class="text-sm text-danger">{{ error }}</p>
            </div>
            <div v-else-if="columnCount === 0" class="flex h-full items-center justify-center text-sm text-muted">
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
