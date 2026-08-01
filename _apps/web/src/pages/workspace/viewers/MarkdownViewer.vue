<script setup lang="ts">
import { Markdown, Segmented } from "@intentic-app/ui";
import { computed, ref, watch } from "vue";
import { fileLinkDecorator } from "../../../composables/renderMarkdown";
import { openFileRefFromEvent } from "../../../composables/workspace/openFileRef";
import type { LineJump } from "../workspaceTabs";
import CodeView from "./CodeView.vue";

/* Markdown preview for the file viewer: renders to prose by default, with a Source toggle that shows the raw
 * markdown highlighted.
 *
 * The prose is the design system's <Markdown> — the same component the documentation extension renders a page
 * with — rather than a v-html of this app's own. That is what makes the two agree on the things a document
 * cannot express as a string: FIGURE FENCES (markdown/figures.ts) are components, so a `stats`/`bars`/`dag`
 * block bound as HTML showed the reader the raw JSON where the picture belongs, and a repository's generated
 * docs are mostly those. Sanitizing (DOMPurify — v-html does not) and the code blocks' copy buttons come with
 * it, so an untrusted workspace file cannot inject script here either.
 *
 * What stays this app's is where a file mention POINTS: the decorator comes from renderMarkdown, and the click
 * that follows one is delegated on the scroll container, since the anchors live inside the component's v-html
 * and can hold no listener of their own. */

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

// Held as a computed so the prop keeps its identity for as long as the file does — the component re-parses the
// document when its decorator changes. A doc that cross-references its neighbours (README → ARCHITECTURE.md)
// navigates like one.
const decorate = computed(() => fileLinkDecorator(path === undefined ? undefined : path.slice(0, path.lastIndexOf(`/`) + 1)));
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
            <!-- Delegated click: the file links live inside the component's v-html, so they can hold no
                 listener of their own (the copy buttons are <Markdown>'s own business). -->
            <div v-if="view === 'preview'" class="scrollbar-thin h-full overflow-auto bg-canvas px-6 py-5" @click="openFileRefFromEvent">
                <Markdown :source="source" :decorate="decorate" class="mx-auto max-w-3xl" />
            </div>
            <CodeView v-else :code="source" lang="markdown" :scroll-to-line="line" />
        </div>
    </div>
</template>
