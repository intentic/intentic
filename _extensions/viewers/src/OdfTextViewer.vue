<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import DocumentPaper from "./DocumentPaper.vue";
import { readTextDocument } from "./odf/document";
import { openOdf, type OdfPackage } from "./odf/pkg";
import { renderBlocks } from "./odf/render";

/* OpenDocument text (.odt) preview: the writer's own pages, with its styles, tables and pictures. */

const { blob } = defineProps<{ blob: Blob }>();

const paper = ref<InstanceType<typeof DocumentPaper>>();
const loading = ref(true);
const error = ref<string>();
const empty = ref(false);
// Drops a stale render when the open file changes mid-parse (a new blob prop supersedes the in-flight one).
let seq = 0;
// The package holds blob URLs for the document's pictures; they leak until it is disposed.
let open: OdfPackage | undefined;

const release = (): void => {
    open?.dispose();
    open = undefined;
};

const render = async (source: Blob): Promise<void> => {
    const host = paper.value?.host;
    if (host === undefined) {
        return;
    }
    const id = ++seq;
    loading.value = true;
    error.value = undefined;
    empty.value = false;
    host.replaceChildren();
    try {
        const bytes = new Uint8Array(await source.arrayBuffer());
        if (id !== seq) {
            return;
        }
        release();
        open = openOdf(bytes);
        const doc = readTextDocument(open);
        empty.value = doc.empty;
        for (const blocks of doc.pages) {
            const page = host.ownerDocument.createElement(`div`);
            page.className = `odf-page`;
            page.style.width = doc.geometry.width;
            page.style.minHeight = doc.geometry.height;
            for (const [property, value] of Object.entries(doc.geometry.margin)) {
                page.style.setProperty(property, value);
            }
            renderBlocks(blocks, page, host.ownerDocument);
            host.append(page);
        }
    } catch (caught) {
        if (id !== seq) {
            return;
        }
        error.value = caught instanceof Error ? caught.message : `Could not render this document.`;
    } finally {
        if (id === seq) {
            loading.value = false;
        }
    }
};

// Parses on the main thread, bounded by the viewer's 25 MiB raw cap; a 750 KiB content.xml parses in about 20ms.
onMounted(() => void render(blob));
watch(
    () => blob,
    (next) => void render(next),
);
onBeforeUnmount(() => {
    seq += 1;
    release();
});
</script>

<template>
    <DocumentPaper ref="paper" :loading="loading" :error="error" :empty="empty" />
</template>
