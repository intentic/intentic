<script setup lang="ts">
import { Icon, Segmented } from "@intentic/extension-ui";
import DOMPurify from "dompurify";
import { computed, onMounted, ref, watch } from "vue";

/* XLSX preview: parses a workbook with SheetJS (lazy-imported — it's a heavy lib) and renders each sheet as an
 * HTML table. A workbook is untrusted (cells can hold arbitrary markup), so sheet_to_html output is
 * DOMPurify-sanitized before v-html. Multiple sheets get a tab switcher. The host (FileViewer) fetches the file's
 * bytes and passes them as `blob`; this component only renders. */

const { blob } = defineProps<{ blob: Blob }>();

const sheets = ref<{ name: string; html: string }[]>([]);
const active = ref(``);
const loading = ref(true);
const error = ref<string>();
// Drops a stale parse when the open file changes mid-flight.
let seq = 0;

const activeHtml = computed(() => sheets.value.find((sheet) => sheet.name === active.value)?.html ?? ``);
const tabOptions = computed(() => sheets.value.map((sheet) => ({ label: sheet.name, value: sheet.name })));

const render = async (source: Blob): Promise<void> => {
    const id = ++seq;
    loading.value = true;
    error.value = undefined;
    sheets.value = [];
    try {
        const XLSX = await import("xlsx");
        const workbook = XLSX.read(new Uint8Array(await source.arrayBuffer()), { type: `array` });
        if (id !== seq) {
            return;
        }
        sheets.value = workbook.SheetNames.flatMap((name) => {
            const worksheet = workbook.Sheets[name];
            return worksheet === undefined ? [] : [{ name, html: DOMPurify.sanitize(XLSX.utils.sheet_to_html(worksheet)) }];
        });
        active.value = sheets.value[0]?.name ?? ``;
    } catch (err) {
        if (id !== seq) {
            return;
        }
        error.value = err instanceof Error ? err.message : `Could not read this spreadsheet.`;
    } finally {
        if (id === seq) {
            loading.value = false;
        }
    }
};

// Parses on the main thread; bounded by the viewer's 25 MiB raw cap. Move to a ?worker if a big sheet janks.
onMounted(() => void render(blob));
watch(
    () => blob,
    (next) => void render(next),
);
</script>

<template>
    <div class="flex h-full min-h-0 flex-col">
        <div v-if="sheets.length > 1" class="flex shrink-0 items-center overflow-x-auto border-b border-line px-2 py-1.5">
            <Segmented v-model="active" size="xs" :options="tabOptions" />
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
