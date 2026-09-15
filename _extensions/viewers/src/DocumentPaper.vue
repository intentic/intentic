<script setup lang="ts">
import { Icon } from "@intentic/extension-ui";
import { ref } from "vue";

/* The paper a document viewer draws on: the scroll surface, its states, and one set of document typography.
   Its pages are built imperatively by whichever viewer owns it, which is why every rule below is `:deep`. */

const { loading, error, empty } = defineProps<{ loading: boolean; error?: string; empty?: boolean }>();

const host = ref<HTMLElement>();

// The element pages are appended to. The viewer owns what goes in it; this component owns how it looks.
defineExpose({ host });
</script>

<template>
    <div class="relative h-full min-h-0">
        <div ref="host" class="odf-doc h-full overflow-auto bg-muted/20"></div>
        <div v-if="loading" class="absolute inset-0 flex items-center justify-center bg-canvas text-muted">
            <Icon name="spinner" class="text-xl" spin />
        </div>
        <div v-else-if="error !== undefined" class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-canvas px-6 text-center">
            <Icon name="exclamation-triangle" class="text-3xl text-danger" />
            <p class="text-sm text-danger">{{ error }}</p>
        </div>
        <div v-else-if="empty === true" class="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted">
            This document has no text in it.
        </div>
    </div>
</template>

<style scoped>
/* A document's own typography, not the app's: the page is paper, whatever colour scheme the app is in. */
.odf-doc {
    padding: 1.5rem 0;
}
.odf-doc :deep(.odf-page) {
    margin: 0 auto 1.5rem;
    max-width: 100%;
    background: #fff;
    color: #111;
    color-scheme: light;
    box-sizing: border-box;
    box-shadow: 0 1px 3px rgb(0 0 0 / 0.28);
    font-family: serif;
    font-size: 12pt;
    line-height: 1.4;
    overflow-wrap: break-word;
}
.odf-doc :deep(p) {
    margin: 0;
    min-height: 1em;
}
.odf-doc :deep(h1),
.odf-doc :deep(h2),
.odf-doc :deep(h3),
.odf-doc :deep(h4),
.odf-doc :deep(h5),
.odf-doc :deep(h6) {
    margin: 0.6em 0 0.3em;
    font-weight: 600;
    line-height: 1.25;
}
.odf-doc :deep(h1) {
    font-size: 1.9em;
}
.odf-doc :deep(h2) {
    font-size: 1.55em;
}
.odf-doc :deep(h3) {
    font-size: 1.3em;
}
.odf-doc :deep(ul),
.odf-doc :deep(ol) {
    margin: 0.2em 0;
    padding-left: 1.6em;
}
.odf-doc :deep(table) {
    border-collapse: collapse;
    margin: 0.5em 0;
    max-width: 100%;
}
/* Only where the document did not say: its own fo:border lands as an inline style and wins over this. */
.odf-doc :deep(td),
.odf-doc :deep(th) {
    border: 1px solid #d4d4d4;
    padding: 0.15em 0.4em;
    vertical-align: top;
}
.odf-doc :deep(a) {
    color: #1a4fd6;
    text-decoration: underline;
}
.odf-doc :deep(img) {
    max-width: 100%;
    height: auto;
}
</style>
