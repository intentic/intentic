<script setup lang="ts">
import { Segmented } from "@intentic-app/ui";
import { copyCodeFromEvent } from "@intentic-app/ui/markdown";
import { computed, ref, watch } from "vue";
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

/* Past this, prose is not what a reader gets — it is a frozen tab. Rendering is one synchronous pass of
 * marked → DOMPurify → the file-link walk → serialize → v-html, and then the browser lays out the result:
 * measured on a 1.9 MiB document, ~500ms of script and 1283ms of layout for 77k nodes. Source view is Monaco,
 * which renders only the lines on screen, so it opens instantly at any size. The toggle stays — this picks
 * which side of it a big document LANDS on, it doesn't take prose away. */
const PROSE_MAX_CHARS = 256 * 1024;
const heavy = source.length > PROSE_MAX_CHARS;
const view = ref<`preview` | `source`>(line !== undefined || heavy ? `source` : `preview`);
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
// Copying also runs off the PRESS (see copyCodeFromEvent) — the click alone loses the button when the prose
// re-renders under it.
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
            <div
                v-if="view === 'preview'"
                class="scrollbar-thin h-full overflow-auto bg-canvas px-6 py-5"
                @click="onMarkdownClick"
                @pointerdown="copyCodeFromEvent"
            >
                <div class="md-prose mx-auto max-w-3xl" v-html="rendered"></div>
            </div>
            <CodeView v-else :code="source" lang="markdown" :scroll-to-line="line" />
        </div>
    </div>
</template>
