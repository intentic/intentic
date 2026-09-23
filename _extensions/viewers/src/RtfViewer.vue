<script setup lang="ts">
import { useLatest } from "@intentic/extension-ui";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import DocumentPaper from "./DocumentPaper.vue";
import { renderBlocks } from "./odf/render";
import { parseRtf } from "./rtf/parse";

/* Rich Text Format (.rtf) preview: the document's own fonts, colours, tables and pictures on a page. */

const { blob } = defineProps<{ blob: Blob }>();

const paper = ref<InstanceType<typeof DocumentPaper>>();
const loading = ref(true);
const error = ref<string>();
const empty = ref(false);
const latest = useLatest();
// Pictures decoded out of the file; they leak until revoked.
let urls: string[] = [];

const release = (): void => {
    for (const url of urls) {
        URL.revokeObjectURL(url);
    }
    urls = [];
};

const render = async (source: Blob): Promise<void> => {
    const host = paper.value?.host;
    if (host === undefined) {
        return;
    }
    const isLatest = latest();
    loading.value = true;
    error.value = undefined;
    empty.value = false;
    host.replaceChildren();
    try {
        const bytes = new Uint8Array(await source.arrayBuffer());
        if (!isLatest()) {
            return;
        }
        release();
        const doc = parseRtf(bytes, (data, type) => {
            const url = URL.createObjectURL(new Blob([new Uint8Array(data)], { type }));
            urls.push(url);
            return url;
        });
        empty.value = doc.empty;
        const page = host.ownerDocument.createElement(`div`);
        page.className = `odf-page`;
        page.style.width = doc.geometry.width;
        for (const [property, value] of Object.entries(doc.geometry.padding)) {
            page.style.setProperty(property, value);
        }
        renderBlocks(doc.blocks, page, host.ownerDocument);
        host.append(page);
    } catch (caught) {
        if (!isLatest()) {
            return;
        }
        error.value = caught instanceof Error ? caught.message : `Could not render this document.`;
    } finally {
        if (isLatest()) {
            loading.value = false;
        }
    }
};

// One sheet, not pages: RTF records where the WRITER's layout broke, which is not where this one does.
onMounted(() => void render(blob));
watch(
    () => blob,
    (next) => void render(next),
);
onBeforeUnmount(release);
</script>

<template>
    <DocumentPaper ref="paper" :loading="loading" :error="error" :empty="empty" />
</template>
