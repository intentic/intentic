<script setup lang="ts">
import { cmp, Icon, Markdown, ResponsiveOverlay, Segmented, useNarrow } from "@intentic/ui";
import { computed, ref, watch } from "vue";
import { fileLinkDecorator } from "../../../composables/renderMarkdown";
import { useLayout } from "../../../composables/useLayout";
import { openFileRefFromEvent } from "../../../composables/workspace/openFileRef";
import { workspaceAgent } from "../../../composables/workspace/workspaceScope";
import type { LineJump } from "../workspaceTabs";
import CodeView from "./CodeView.vue";
import MarkdownOutline from "./MarkdownOutline.vue";
import { useMarkdownOutline } from "./markdownOutline";

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
 * and can hold no listener of their own.
 *
 * AND WHERE THE READER IS IN IT. A rendered document is the one surface in this app with no way to move around
 * inside itself: the code beside it has a minimap, a gutter and a jump-to-line, and prose had a scrollbar. So
 * the preview carries its own headings (markdownOutline.ts) as a rail, the section you are in, and how far
 * through you are — see MarkdownOutline.vue for why that is a list of words and not a minimap. */

// `line` = a content-search match landing here: open on (or switch to) the Source view so the hit is visible —
// rendered prose has no stable line mapping.
// `path` is the document's own workspace path. Its directory is what the file links inside resolve against, so
// `docs/a.md` linking `./b.md` opens `docs/b.md`.
const { source, path, line } = defineProps<{ source: string; path: string; line?: LineJump }>();

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
// navigates like one, and it stays in the copy of the workspace the reader is already in (workspaceScope):
// following a link out of an agent's README into the shared tree's ARCHITECTURE.md would be the same
// same-path-different-file confusion one level down.
const decorate = computed(() => fileLinkDecorator({ dir: path.slice(0, path.lastIndexOf(`/`) + 1), agent: workspaceAgent.value }));

const layout = useLayout();
const scroller = ref<HTMLElement>();
const outline = useMarkdownOutline(scroller);

/* WORTH A RAIL AT THREE SECTIONS. A document with two has a table of contents you can already see, and drawing
 * one for it spends a column saying what the first screen says. Same threshold the docs site's rail uses. */
const OUTLINE_MIN = 3;
const worthIt = computed(() => outline.headings.value.length >= OUTLINE_MIN);

/* ROOM FOR A RAIL, MEASURED OFF THE PANE AND NEVER THE WINDOW — this view renders between the file tree and a
 * chat panel the reader can drag to half the screen, so a wide monitor routinely hands it 500px. The number is
 * what the two columns need together: 13rem of rail, the gutter either side, and enough left for prose to keep
 * a measure worth reading at. Under it the rail does not dock at all — the outline is still one press away in
 * the toolbar, which is the whole reason that control exists. */
const RAIL_AT_REM = 52;
const root = ref<HTMLElement>();
const narrow = useNarrow(root, RAIL_AT_REM);

const docked = computed(() => view.value === `preview` && worthIt.value && !narrow.value && layout.markdownOutline.value);
// The rail's own control, so it is absent where it would promise something the pane cannot give.
const dockable = computed(() => view.value === `preview` && worthIt.value && !narrow.value);
// "You are here", for when the rail is not saying it. Doubles as the opener for the overlay copy of the outline.
const current = computed(() =>
    view.value === `preview` && worthIt.value && !docked.value ? outline.headings.value[outline.active.value]?.text : undefined,
);

const overlayOpen = ref(false);
const opener = ref<HTMLElement>();
const jumpFromOverlay = (index: number): void => {
    overlayOpen.value = false;
    outline.jump(index);
};

/* THE OVERLAY MAY ONLY BE OPEN WHILE ITS OPENER EXISTS. An anchored panel is placed against that button, so
 * anything that takes the button away mid-open — docking the rail, switching to Source, a pane widening past
 * the threshold — would leave the panel hanging off an element that is no longer on screen. The same watcher
 * closes it when the document changes underneath (a tab reused for another file), since a menu of one
 * document's sections over another document's prose is a menu describing nothing the reader can see. */
// Watched as "is there an opener at all", not as the section name — that changes on every scroll, and closing
// the panel because the reader scrolled past a heading is not what this is for.
watch([() => current.value === undefined, () => path], () => (overlayOpen.value = false));
</script>

<template>
    <div ref="root" class="flex h-full min-h-0 flex-col">
        <div class="relative flex shrink-0 items-center gap-2 border-b border-line px-2 py-1.5">
            <Segmented
                v-model="view"
                :options="[
                    { label: `Preview`, value: `preview` },
                    { label: `Source`, value: `source` },
                ]"
            />

            <!-- The section the reader is in. A button rather than a label because the list behind it is what
                 they want next often enough to be worth the press — and on a pane too narrow to dock the rail,
                 this is the only way to it. -->
            <button
                v-if="current !== undefined"
                ref="opener"
                type="button"
                class="flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-2xs text-muted transition-colors hover:bg-overlay hover:text-content"
                v-tooltip.bottom="'Outline'"
                @click="overlayOpen = !overlayOpen"
            >
                <Icon name="align-left" class="shrink-0 text-subtle" aria-hidden="true" />
                <span class="truncate">{{ current }}</span>
            </button>

            <div class="min-w-0 flex-1"></div>

            <button
                v-if="dockable"
                type="button"
                :class="cmp.iconButton()"
                :aria-pressed="docked"
                v-tooltip.bottom="docked ? `Hide outline` : `Show outline`"
                :aria-label="docked ? `Hide outline` : `Show outline`"
                @click="layout.toggleMarkdownOutline()"
            >
                <Icon name="align-left" />
            </button>

            <!-- HOW MUCH IS LEFT, drawn over the toolbar's own bottom rule rather than as a bar of its own: a
                 reading position is a hairline's worth of information and does not deserve a row. Absent while
                 the document fits its pane — a full-width accent line under the toolbar of a short file reads
                 as a progress bar that finished, which is a claim about loading, not about reading. -->
            <div
                v-if="view === `preview` && outline.scrollable.value"
                class="pointer-events-none absolute -bottom-px left-0 h-px bg-link/60"
                :style="{ width: `${outline.progress.value * 100}%` }"
                aria-hidden="true"
            ></div>
        </div>

        <div class="relative flex min-h-0 flex-1">
            <!-- Delegated click: the file links live inside the component's v-html, so they can hold no
                 listener of their own (the copy buttons are <Markdown>'s own business). -->
            <template v-if="view === `preview`">
                <!-- THE SCROLLER SPANS THE WHOLE PANE, so its scrollbar sits at the pane's outermost edge —
                     which is the entire point of the layout below. The rail used to be a column BESIDE this
                     one, which put the scrollbar between the document and the rail: a solid bar reporting
                     position, a few pixels from a lit border reporting position, in two visual languages. Now
                     the document keeps the room the rail occupies as PADDING, and the rail parks in it.

                     `ui-softscroll`, not `scrollbar-thin`: a whisper until the pointer is in the column, a real
                     thumb the moment it is — right for a surface being read rather than scanned. Its stable
                     gutter is also what makes the rail's inset below a constant. -->
                <div
                    ref="scroller"
                    class="ui-softscroll h-full min-w-0 flex-1 overflow-auto bg-canvas py-5 pl-6"
                    :class="docked ? `pr-[13.5rem]` : `pr-6`"
                    @click="openFileRefFromEvent"
                >
                    <Markdown :source="source" :decorate="decorate" class="mx-auto max-w-3xl" />
                </div>
                <!-- Parked in that padding rather than laid out beside it, and OUTSIDE the scroller rather than
                     stuck to the top of it: pinned to the pane, it neither scrolls away with the document nor
                     slides sideways when a wide table scrolls, and `inset-y-0` hands it the visible height for
                     free, so its own list scrolls independently of the document's. `right` is the measured
                     scrollbar strip — the one number that keeps it clear of the bar without covering it.

                     NO BORDER ON THIS EDGE. The rows inside already draw a line down their left; a container
                     rule beside it was a second hairline drawing the same boundary twice. It carries the
                     canvas colour because content wider than the reading column scrolls underneath it. -->
                <aside
                    v-if="docked"
                    class="absolute inset-y-0 flex w-52 flex-col bg-canvas py-5 pl-2 pr-2"
                    :style="{ right: `${outline.gutter.value}px` }"
                >
                    <MarkdownOutline :headings="outline.headings.value" :active="outline.active.value" @jump="outline.jump" />
                </aside>
            </template>
            <CodeView v-else class="min-w-0 flex-1" :code="source" lang="markdown" :scroll-to-line="line" />
        </div>

        <!-- The same outline, for the pane that cannot dock one (and for a peek at it after the rail is off).
             Anchored to the section button on a desktop, a sheet on a phone. -->
        <ResponsiveOverlay v-model="overlayOpen" :anchor="opener" header="Outline" panel-class="max-h-[60vh] w-72 p-2">
            <MarkdownOutline :headings="outline.headings.value" :active="outline.active.value" @jump="jumpFromOverlay" />
        </ResponsiveOverlay>
    </div>
</template>
