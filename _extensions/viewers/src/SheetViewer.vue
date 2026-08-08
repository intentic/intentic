<script setup lang="ts">
import { Icon, Segmented } from "@intentic/extension-ui";
import DOMPurify from "dompurify";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { createSheetWorkerClient } from "./sheetWorkerClient";

/* XLSX preview: transfers a workbook to a dedicated worker, which parses it once and converts only the selected
 * sheet to an HTML table. A workbook is untrusted, so the returned markup is DOMPurify-sanitized on the main
 * thread before v-html. The host (FileViewer) fetches the file's bytes and passes them as `blob`. */

const { blob } = defineProps<{ blob: Blob }>();

const sheets = ref<readonly string[]>([]);
const active = ref(``);
const activeHtml = ref(``);
const loading = ref(true);
const error = ref<string>();
// Drops a stale parse when the open file changes, and a stale render when tabs are switched in quick succession.
let seq = 0;
let renderSeq = 0;
let client: ReturnType<typeof createSheetWorkerClient> | undefined;

const tabOptions = computed(() => sheets.value.map((name) => ({ label: name, value: name })));

const renderSheet = async (name: string, id: number, target: NonNullable<typeof client>): Promise<void> => {
    const selected = ++renderSeq;
    active.value = name;
    activeHtml.value = ``;
    loading.value = true;
    error.value = undefined;
    try {
        const html = await target.render(name);
        if (id !== seq || selected !== renderSeq || target !== client) {
            return;
        }
        activeHtml.value = DOMPurify.sanitize(html);
    } catch (caught) {
        if (id !== seq || selected !== renderSeq || target !== client) {
            return;
        }
        error.value = caught instanceof Error ? caught.message : `Could not read this spreadsheet.`;
    } finally {
        if (id === seq && selected === renderSeq && target === client) {
            loading.value = false;
        }
    }
};

const select = (name: string): void => {
    if (client !== undefined) {
        void renderSheet(name, seq, client);
    }
};

const render = async (source: Blob): Promise<void> => {
    const id = ++seq;
    renderSeq += 1;
    client?.close();
    client = undefined;
    loading.value = true;
    error.value = undefined;
    sheets.value = [];
    active.value = ``;
    activeHtml.value = ``;
    try {
        const buffer = await source.arrayBuffer();
        if (id !== seq) {
            return;
        }
        const { default: SheetWorker } = await import(`./sheetWorker?worker`);
        if (id !== seq) {
            return;
        }
        const next = createSheetWorkerClient(new SheetWorker());
        client = next;
        const names = await next.load(buffer);
        if (id !== seq || next !== client) {
            return;
        }
        sheets.value = names;
        const first = names[0];
        if (first === undefined) {
            loading.value = false;
            return;
        }
        await renderSheet(first, id, next);
    } catch (caught) {
        if (id !== seq) {
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
onBeforeUnmount(() => {
    seq += 1;
    renderSeq += 1;
    client?.close();
});
</script>

<template>
    <div class="flex h-full min-h-0 flex-col">
        <div v-if="sheets.length > 1" class="flex shrink-0 items-center overflow-x-auto border-b border-line px-2 py-1.5">
            <Segmented v-model="active" size="xs" :options="tabOptions" @update:model-value="select" />
        </div>
        <div class="min-h-0 flex-1">
            <div v-if="loading" class="flex h-full items-center justify-center text-muted"><Icon name="spinner" class="text-xl" spin /></div>
            <div v-else-if="error" class="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                <Icon name="exclamation-triangle" class="text-3xl text-danger" />
                <p class="text-sm text-danger">{{ error }}</p>
            </div>
            <div v-else class="xlsx-sheet scrollbar-thin h-full overflow-auto p-4" v-html="activeHtml"></div>
        </div>
    </div>
</template>

<!-- Unscoped: styles target the v-html-injected table (scoped selectors don't reach injected nodes). -->
<style>
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
.xlsx-sheet tr:first-child td {
    background: var(--color-card);
    font-weight: 600;
}
</style>
