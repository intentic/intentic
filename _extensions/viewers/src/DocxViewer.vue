<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import { fitPages, keepFitted } from "./docxFit.js";
import { t } from "./i18n.js";
import ViewerStatus from "./load/ViewerStatus.vue";
import { useViewerLoad } from "./load/useViewerLoad.js";
import { swapChildren } from "./load/liveSwap.js";

/* DOCX preview: renders a Word document into HTML via docx-preview (lazy-imported so its ~jszip payload stays out of the initial bundle). */

const { blob } = defineProps<{ blob: Blob }>();

const container = ref<HTMLElement>();
const { loading, error, stale, start, drawn } = useViewerLoad(() => t(`common.couldNotRenderDocument`));

const render = async (source: Blob): Promise<void> => {
    const host = container.value;
    if (host === undefined) {
        return;
    }
    // Drawn aside and swapped in whole: a file read mid-write throws here and leaves the last rendering (liveSwap.ts).
    const refresh = drawn();
    await start(async (isLatest) => {
        const swapped = await swapChildren(
            host,
            async (staging) => {
                const { renderAsync } = await import("docx-preview");
                if (!isLatest()) {
                    return false;
                }
                await renderAsync(source, staging);
                return isLatest();
            },
            refresh,
        );
        if (swapped) {
            fitPages(host);
        }
    });
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
        <ViewerStatus overlay :loading="loading" :error="error" :stale="stale" />
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
