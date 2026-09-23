<script setup lang="ts">
import { Icon, useLatest } from "@intentic/extension-ui";
import { onMounted, onUnmounted, ref, watch } from "vue";
import { fitPages, keepFitted } from "./docxFit.js";

/* DOCX preview: renders a Word document into HTML via docx-preview (lazy-imported so its ~jszip payload stays out of the initial bundle). */

const { blob } = defineProps<{ blob: Blob }>();

const container = ref<HTMLElement>();
const loading = ref(true);
const error = ref<string>();
const latest = useLatest();

const render = async (source: Blob): Promise<void> => {
    const host = container.value;
    if (host === undefined) {
        return;
    }
    const isLatest = latest();
    loading.value = true;
    error.value = undefined;
    host.replaceChildren();
    try {
        const { renderAsync } = await import("docx-preview");
        if (!isLatest()) {
            return;
        }
        await renderAsync(source, host);
        if (!isLatest()) {
            return;
        }
        fitPages(host);
    } catch (err) {
        if (!isLatest()) {
            return;
        }
        error.value = err instanceof Error ? err.message : `Could not render this document.`;
    } finally {
        if (isLatest()) {
            loading.value = false;
        }
    }
};

// Parses on the main thread; bounded by the viewer's 25 MiB raw cap. If a huge .docx janks the UI, move the
// parse into a ?worker module (Vite supports it out of the box).
let unfit: (() => void) | undefined;
onMounted(() => {
    if (container.value !== undefined) {
        unfit = keepFitted(container.value);
    }
    void render(blob);
});
onUnmounted(() => unfit?.());
watch(
    () => blob,
    (next) => void render(next),
);
</script>

<template>
    <div class="relative h-full min-h-0">
        <div ref="container" class="docx-host h-full overflow-auto bg-muted/20"></div>
        <div v-if="loading" class="absolute inset-0 flex items-center justify-center bg-canvas text-muted">
            <Icon name="spinner" class="text-xl" spin />
        </div>
        <div v-else-if="error" class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-canvas px-6 text-center">
            <Icon name="exclamation-triangle" class="text-3xl text-danger" />
            <p class="text-sm text-danger">{{ error }}</p>
        </div>
    </div>
</template>

<style scoped>
/* docx-preview centers its own white "pages" in a wrapper; give the gutter a little breathing room. A page wider than
   the pane (fit stops at half size) starts at the left edge, where a scroll can reach it, rather than centred and cut. */
.docx-host :deep(.docx-wrapper) {
    padding: 1.5rem 0;
    background: transparent;
    align-items: safe center;
}
</style>
