<script setup lang="ts">
import { Segmented } from "@intentic-app/ui";
import { computed, ref, watch } from "vue";
import { copyCodeFromEvent } from "../../../composables/markdownCode";
import { renderMarkdown } from "../../../composables/renderMarkdown";
import { openFileRefFromEvent } from "../../../composables/workspace/openFileRef";
import type { LineJump } from "../workspaceTabs";
import CodeView from "./CodeView.vue";

/* Markdown preview for the file viewer: renders to prose by default, with a Source toggle that shows the raw
 * markdown highlighted. Workspace files are untrusted, so the HTML is sanitized (renderMarkdown → DOMPurify)
 * before v-html — Vue's v-html does NOT sanitize, and marked passes inline HTML through, so a raw bind would
 * be stored XSS. DOMPurify strips <script>/onerror=/javascript: while keeping the prose. */

// `line` = a content-search match landing here: open on (or switch to) the Source view so the hit is visible —
// rendered prose has no stable line mapping.
// `path` is the document's own workspace path, present when this is a FILE (absent for the chat's plan preview,
// whose references are already workspace-root-relative). Its directory is what the file links inside resolve
// against, so `docs/a.md` linking `./b.md` opens `docs/b.md`.
const { source, path, line } = defineProps<{ source: string; path?: string; line?: LineJump }>();
const view = ref<`preview` | `source`>(line !== undefined ? `source` : `preview`);
watch(
    () => line,
    (next) => {
        if (next !== undefined) {
            view.value = `source`;
        }
    },
);

const rendered = computed<string>(() => renderMarkdown(source, path === undefined ? undefined : path.slice(0, path.lastIndexOf(`/`) + 1)));

// One delegated listener for every control the rendered markdown carries — a code block's copy button and the
// file links a mentioned path becomes. Both live inside v-html, so neither can hold a component of its own.
// A doc that cross-references its neighbours (README → ARCHITECTURE.md) now navigates like one.
const onMarkdownClick = (event: MouseEvent): void => {
    copyCodeFromEvent(event);
    openFileRefFromEvent(event);
};
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
            <!-- Delegated click: the copy buttons and file links live inside v-html (see onMarkdownClick). -->
            <div v-if="view === 'preview'" class="scrollbar-thin h-full overflow-auto bg-canvas px-6 py-5" @click="onMarkdownClick">
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
/* A file this document names, linkified by markdownFileLinks — clicking opens it in the editor. The dotted rule
   is the affordance: a path reads as "opens here" before it is hovered, and stays distinguishable from an
   outbound link, which is undecorated until hover. Written one level more specific than the rule above so it
   wins the text-decoration regardless of stylesheet order. */
.md-prose a.md-file-link {
    text-decoration: underline dotted color-mix(in srgb, var(--color-link) 45%, transparent);
    text-underline-offset: 0.2em;
}
.md-prose a.md-file-link:hover {
    text-decoration: underline solid var(--color-link);
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
