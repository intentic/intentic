<script setup lang="ts">
import { Segmented } from "@intentic-app/ui";
import { computed, ref, watch } from "vue";
import { renderMarkdown } from "../../../composables/renderMarkdown";
import type { LineJump } from "../workspaceTabs";
import CodeView from "./CodeView.vue";

/* Markdown preview for the file viewer: renders to prose by default, with a Source toggle that shows the raw
 * markdown highlighted. Workspace files are untrusted, so the HTML is sanitized (renderMarkdown → DOMPurify)
 * before v-html — Vue's v-html does NOT sanitize, and marked passes inline HTML through, so a raw bind would
 * be stored XSS. DOMPurify strips <script>/onerror=/javascript: while keeping the prose. */

// `line` = a content-search match landing here: open on (or switch to) the Source view so the hit is visible —
// rendered prose has no stable line mapping.
const { source, line } = defineProps<{ source: string; line?: LineJump }>();
const view = ref<`preview` | `source`>(line !== undefined ? `source` : `preview`);
watch(
    () => line,
    (next) => {
        if (next !== undefined) {
            view.value = `source`;
        }
    },
);

const rendered = computed<string>(() => renderMarkdown(source));
</script>

<template>
    <div class="flex h-full min-h-0 flex-col">
        <div class="flex shrink-0 items-center border-b border-line px-2 py-1.5">
            <Segmented
                v-model="view"
                :options="[
                    { label: `Preview`, value: `preview` },
                    { label: `Source`, value: `source` },
                ]"
            />
        </div>
        <div class="min-h-0 flex-1">
            <div v-if="view === 'preview'" class="scrollbar-thin h-full overflow-auto bg-canvas px-6 py-5">
                <div class="md-prose mx-auto max-w-3xl text-content/90" v-html="rendered"></div>
            </div>
            <CodeView v-else :code="source" lang="markdown" :scroll-to-line="line" />
        </div>
    </div>
</template>

<!-- Unscoped: styles target the v-html-injected prose (scoped selectors don't reach injected nodes). -->
<style>
.md-prose {
    font-size: 0.875rem;
    line-height: 1.65;
}
.md-prose > :first-child {
    margin-top: 0;
}
.md-prose > :last-child {
    margin-bottom: 0;
}
.md-prose p {
    margin: 0.7rem 0;
}
.md-prose h1,
.md-prose h2,
.md-prose h3,
.md-prose h4 {
    margin: 1.4rem 0 0.6rem;
    font-weight: 600;
    line-height: 1.3;
}
.md-prose h1 {
    font-size: 1.5rem;
}
.md-prose h2 {
    font-size: 1.25rem;
    border-bottom: 1px solid var(--color-line);
    padding-bottom: 0.3rem;
}
.md-prose h3 {
    font-size: 1.1rem;
}
.md-prose h4 {
    font-size: 0.95rem;
}
.md-prose ul,
.md-prose ol {
    margin: 0.7rem 0;
    padding-left: 1.5rem;
}
.md-prose li {
    margin: 0.3rem 0;
}
.md-prose li > ul,
.md-prose li > ol {
    margin: 0.3rem 0;
}
.md-prose strong {
    font-weight: 600;
}
.md-prose blockquote {
    margin: 0.7rem 0;
    padding: 0.1rem 0 0.1rem 0.9rem;
    border-left: 3px solid var(--color-line-strong);
    color: var(--color-muted);
}
.md-prose hr {
    margin: 1.2rem 0;
    border: 0;
    border-top: 1px solid var(--color-line);
}
.md-prose img {
    max-width: 100%;
    border-radius: var(--radius-md);
}
.md-prose pre {
    margin: 0.8rem 0;
    overflow-x: auto;
    border: 1px solid var(--color-line);
    border-radius: var(--radius-md);
    background: var(--color-canvas);
    padding: 0.85rem;
}
.md-prose pre code {
    background: transparent;
    padding: 0;
    font-size: 0.8125rem;
}
.md-prose code {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 0.85em;
    background: color-mix(in srgb, var(--color-content) 9%, transparent);
    padding: 0.1em 0.34em;
    border-radius: var(--radius-xs);
}
.md-prose a {
    color: var(--color-link);
    text-decoration: none;
}
.md-prose a:hover {
    text-decoration: underline;
}
.md-prose table {
    width: 100%;
    margin: 0.8rem 0;
    border-collapse: collapse;
    font-size: 0.875rem;
}
.md-prose th,
.md-prose td {
    padding: 0.45rem 0.65rem;
    text-align: left;
    border-bottom: 1px solid var(--color-line);
}
.md-prose th {
    font-weight: 600;
    color: var(--color-content);
}
</style>
