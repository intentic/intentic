<script setup lang="ts">
import { onMounted, ref, watch } from "vue";

/* DOCX preview: renders a Word document into HTML via docx-preview (lazy-imported so its ~jszip payload stays
 * out of the initial bundle). docx-preview builds DOM nodes programmatically from the OOXML — it does not inject
 * the document's own raw HTML — and we mount it in a container we own, so a workspace .docx can't run script. */

const { blob } = defineProps<{ blob: Blob }>();

const container = ref<HTMLElement>();
const loading = ref(true);
const error = ref<string>();
// Drops a stale render when the open file changes mid-parse (a new blob prop supersedes the in-flight one).
let seq = 0;

const render = async (source: Blob): Promise<void> => {
    const host = container.value;
    if (host === undefined) {
        return;
    }
    const id = ++seq;
    loading.value = true;
    error.value = undefined;
    host.replaceChildren();
    try {
        const { renderAsync } = await import("docx-preview");
        if (id !== seq) {
            return;
        }
        await renderAsync(source, host);
        if (id !== seq) {
            return;
        }
    } catch (err) {
        if (id !== seq) {
            return;
        }
        error.value = err instanceof Error ? err.message : `Could not render this document.`;
    } finally {
        if (id === seq) {
            loading.value = false;
        }
    }
};

// ponytail: parses on the main thread; bounded by the viewer's 25 MiB raw cap. If a huge .docx janks the UI,
// move the parse into a ?worker module (Vite supports it out of the box).
onMounted(() => void render(blob));
watch(
    () => blob,
    (next) => void render(next),
);
</script>

<template>
    <div class="relative h-full min-h-0">
        <div ref="container" class="docx-host scrollbar-thin h-full overflow-auto bg-muted/20"></div>
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
/* docx-preview centers its own white "pages" in a wrapper; give the gutter a little breathing room. */
.docx-host :deep(.docx-wrapper) {
    padding: 1.5rem 0;
    background: transparent;
}
</style>
