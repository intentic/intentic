<script setup lang="ts">
import { Button, ui, Icon, Markdown, ResponsiveOverlay, useNarrow } from "@intentic/ui";
import { type MarkdownDecorator, offsetOfLine } from "@intentic/ui/markdown";
import { computed, ref, watch } from "vue";
import { fileLinkDecorator } from "../../../composables/renderMarkdown";
import { useLayout } from "../../../composables/useLayout";
import { openFileRefFromEvent } from "../../../composables/workspace/openFileRef";
import { workspaceAgent } from "../../../composables/workspace/workspaceScope";
import type { LineJump } from "../workspaceTabs";
import CodeView from "./CodeView.vue";
import MarkdownDocumentSurface from "./MarkdownDocumentSurface.vue";
import MarkdownOutline from "./MarkdownOutline.vue";
import { toggleTaskCheckbox } from "./markdownTasks";
import { useMarkdownOutline } from "./markdownOutline";
import { VIEWER_ACTIONS_TARGET } from "../viewerChrome";

/* THE MARKDOWN SURFACE: one rendered document, in both of the app's two states.
 *
 * A markdown file has two honest forms, its source and its rendered prose, and the rendered one is what people
 * read. So this surface renders, always, and the app's ordinary Edit switch (FileViewer's breadcrumb, the same
 * button every other file has) decides whether you can type into what you are reading. There is no third mode
 * and no control of its own: markdown behaves like the rest of the app, it just has a nicer thing to edit.
 *
 * THE TWO RENDERINGS ARE THE SAME PICTURE. Reading is <Markdown> (marked → sanitize → v-html, the engine every
 * prose surface in the app shares). Editing is MarkdownDocumentSurface, which builds the document out of its own
 * source so that the DOM's text IS the file, with the markup characters present but hidden. Both carry
 * `md-prose`, so both are styled by the one set of type rules, and switching between them moves nothing.
 *
 * WHAT EDITING FEELS LIKE. Click a paragraph and the caret goes where you clicked. The block you are in reveals
 * its markdown, `##` and `-` hanging in the margin so the words do not shift; every other block stays clean.
 * Nothing is swapped for an editor widget, so there is nothing to flicker, resize or re-focus. That is VS Code's
 * hybrid markdown editor's model, and the reason it is theirs is that anything less exact reads as a jump.
 *
 * THE SOURCE VIEW STAYS, as an escape hatch and not as half of a toggle: it is where a construct the renderer
 * swallows can be fixed, and where a content-search hit lands, because a line number is a fact about source.
 *
 * TICKING A BOX IS NOT EDITING, so checkboxes are live while merely reading: it is a fact about the work, every
 * other checklist in the app is clickable, and the plans agents write here are full of them. */

// `line` = a content-search match landing here. `editable` is the HOST's permission (never in a conversation's
// copy of the workspace, never on mobile); whether the reader is editing is the app's own Edit switch.
const { source, path, line, editable } = defineProps<{ source: string; path: string; line?: LineJump; editable?: boolean }>();
const emit = defineEmits<{ change: [value: string]; save: [value: string] }>();

const layout = useLayout();

/* The document, held rather than watched, exactly like the editable CodeView beside it: `source` is a SEED and
 * this surface owns the text from mount onwards. FileViewer re-keys the component whenever disk should win. */
const doc = ref(source);
// Where to put the caret when the editing surface mounts: a content-search hit, or nothing.
const landing = ref<number | undefined>(undefined);

/* Past this, prose is not what a reader gets: it is a frozen tab. Rendering is one synchronous pass of
 * marked → DOMPurify → the file-link walk → serialize → v-html, and then the browser lays out the result:
 * measured on a 1.9 MiB document, ~500ms of script and 1283ms of layout for 77k nodes. Source view is Monaco,
 * which renders only the lines on screen, so it opens instantly at any size. */
const PROSE_MAX_CHARS = 256 * 1024;
const heavy = source.length > PROSE_MAX_CHARS;
const view = ref<`document` | `source`>(heavy ? `source` : `document`);

// Typing into the document: the host allows it AND the reader has the app's Edit switch on. One switch, the same
// one every other file answers to.
const editing = computed(() => editable === true && layout.editMode.value && view.value === `document`);

// Held as a computed so the prop keeps its identity for as long as the file does: the component re-parses the
// document when its decorator changes. A doc that cross-references its neighbours (README → ARCHITECTURE.md)
// navigates like one, and it stays in the copy of the workspace the reader is already in (workspaceScope).
const decorate = computed<MarkdownDecorator>(() => {
    const links = fileLinkDecorator({ dir: path.slice(0, path.lastIndexOf(`/`) + 1), agent: workspaceAgent.value });
    const tickable = editable === true;
    return (fragment) => {
        links(fragment);
        // marked renders task boxes disabled, and a disabled input fires no click at all. Enabling them is what
        // makes a checklist in a plan file behave like every other checklist in the app.
        if (tickable) {
            for (const box of fragment.querySelectorAll<HTMLInputElement>(`input[type="checkbox"]`)) {
                box.removeAttribute(`disabled`);
                box.classList.add(`md-task-box`);
            }
        }
    };
});

const scroller = ref<HTMLElement>();
const outline = useMarkdownOutline(scroller);
const surface = ref<InstanceType<typeof MarkdownDocumentSurface>>();
const sourceView = ref<InstanceType<typeof CodeView>>();

const onChange = (value: string): void => {
    doc.value = value;
    emit(`change`, value);
};

const save = (): void => {
    if (view.value === `source`) {
        sourceView.value?.save();
        return;
    }
    emit(`save`, surface.value?.text() ?? doc.value);
};
defineExpose({ save });

/* Clicks on the READING surface: a file mention opens its file, a checkbox ticks. Neither is available while
 * editing, where the same characters are text under the caret and a click places it. */
const onPreviewClick = (event: MouseEvent): void => {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.type === `checkbox`) {
        event.preventDefault();
        const boxes = [...(scroller.value?.querySelectorAll(`.md-prose input[type="checkbox"]`) ?? [])];
        const next = toggleTaskCheckbox(doc.value, boxes.indexOf(target));
        if (next !== undefined) {
            onChange(next);
        }
        return;
    }
    openFileRefFromEvent(event);
};

/* A content-search hit is about a LINE. Editing the document, that is an offset the caret can be put at; reading
 * it, prose has no stable line mapping, so the hit goes to the source view, which is what it is for. */
watch(
    () => line,
    (next) => {
        if (next === undefined) {
            return;
        }
        if (editable === true && layout.editMode.value && !heavy) {
            view.value = `document`;
            landing.value = offsetOfLine(doc.value, next.line);
            return;
        }
        view.value = `source`;
    },
    { immediate: true },
);

/* WORTH A RAIL AT THREE SECTIONS. A document with two has a table of contents you can already see, and drawing
 * one for it spends a column saying what the first screen says. Same threshold the docs site's rail uses. */
const OUTLINE_MIN = 3;
const worthIt = computed(() => outline.headings.value.length >= OUTLINE_MIN);

/* ROOM FOR A RAIL, MEASURED OFF THE PANE AND NEVER THE WINDOW: this view renders between the file tree and a
 * chat panel the reader can drag to half the screen, so a wide monitor routinely hands it 500px. The number is
 * what the two columns need together: 18rem of rail, the gutter either side, and enough left for prose to keep
 * a measure worth reading at. Under it the rail does not dock at all: the outline is still one press away in
 * the toolbar, which is the whole reason that control exists. */
const RAIL_AT_REM = 57;
const root = ref<HTMLElement>();
const narrow = useNarrow(root, RAIL_AT_REM);

const docked = computed(() => view.value === `document` && worthIt.value && !narrow.value && layout.markdownOutline.value);
// The rail's own control, so it is absent where it would promise something the pane cannot give.
const dockable = computed(() => view.value === `document` && worthIt.value && !narrow.value);
// "You are here", for when the rail is not saying it. Doubles as the opener for the overlay copy of the outline.
const current = computed(() =>
    view.value === `document` && worthIt.value && !docked.value ? outline.headings.value[outline.active.value]?.text : undefined,
);

const overlayOpen = ref(false);
const opener = ref<HTMLElement>();
const jumpFromOverlay = (index: number): void => {
    overlayOpen.value = false;
    outline.jump(index);
};

/* THE OVERLAY MAY ONLY BE OPEN WHILE ITS OPENER EXISTS. An anchored panel is placed against that button, so
 * anything that takes the button away mid-open: docking the rail, switching to Source, a pane widening past
 * the threshold: would leave the panel hanging off an element that is no longer on screen. The same watcher
 * closes it when the document changes underneath (a tab reused for another file), since a menu of one
 * document's sections over another document's prose is a menu describing nothing the reader can see. */
// Watched as "is there an opener at all", not as the section name: that changes on every scroll, and closing
// the panel because the reader scrolled past a heading is not what this is for.
watch([() => current.value === undefined, () => path], () => (overlayOpen.value = false));
</script>

<template>
    <div ref="root" class="flex h-full min-h-0 flex-col">
        <!-- THIS SURFACE OPENS NO BAR OF ITS OWN. Three controls and a section name are not a toolbar's worth
             of content, and a band of them under the breadcrumb, under the tab row, put a markdown file's
             first line four rules down the screen. They ride the breadcrumb instead (see viewerChrome), which
             on the desktop is itself riding the tab row: same controls, same order, no band. -->
        <Teleport defer :to="`#${VIEWER_ACTIONS_TARGET}`">
            <!-- The section the reader is in. A button rather than a label because the list behind it is what
                 they want next often enough to be worth the press, and on a pane too narrow to dock the rail,
                 this is the only way to it. -->
            <Button
                v-if="current !== undefined"
                ref="opener"
                size="small"
                severity="secondary"
                :text="true"
                class="min-w-0"
                v-tooltip.bottom="'Outline'"
                @click="overlayOpen = !overlayOpen"
            >
                <Icon name="align-left" class="shrink-0 text-subtle" aria-hidden="true" />
                <!-- Narrower here than it was on a bar of its own, and it has to be: this now shares a row with
                     the tab strip. The glyph alone still opens the outline, which is the control's whole job. -->
                <span class="max-w-32 truncate max-md:hidden">{{ current }}</span>
            </Button>

            <button
                v-if="dockable"
                type="button"
                :class="ui.iconButton()"
                :aria-pressed="docked"
                v-tooltip.bottom="docked ? `Hide outline` : `Show outline`"
                :aria-label="docked ? `Hide outline` : `Show outline`"
                @click="layout.toggleMarkdownOutline()"
            >
                <Icon name="align-left" />
            </button>

            <!-- THE WAY OUT, not half of a toggle. The document is where this file is read and written; source
                 is for what prose cannot express: the blank line between two blocks, a construct the renderer
                 swallowed, the line a search matched. -->
            <button
                type="button"
                :class="ui.iconButton()"
                :aria-pressed="view === `source`"
                v-tooltip.bottom="view === `source` ? `Back to the document` : `View markdown source`"
                :aria-label="view === `source` ? `Back to the document` : `View markdown source`"
                @click="view = view === `source` ? `document` : `source`"
            >
                <Icon :name="view === `source` ? `eye` : `code`" />
            </button>
        </Teleport>

        <div class="relative flex min-h-0 flex-1">
            <!-- HOW MUCH IS LEFT, a hairline along the top of the document rather than a bar of its own: a
                 reading position is a hairline's worth of information and does not deserve a row. It used to
                 hang off the toolbar's bottom rule, which is the same edge, and now that the toolbar has gone
                 up into the breadcrumb it hangs off the rule the document has instead. Absent while the
                 document fits its pane: a full-width accent line over a short file reads as a progress bar
                 that finished, which is a claim about loading, not about reading. -->
            <div
                v-if="view === `document` && outline.scrollable.value"
                class="pointer-events-none absolute left-0 top-0 z-10 h-px bg-link/60"
                :style="{ width: `${outline.progress.value * 100}%` }"
                aria-hidden="true"
            ></div>
            <template v-if="view === `document`">
                <!-- THE SCROLLER SPANS THE WHOLE PANE, so its scrollbar sits at the pane's outermost edge:
                     which is the entire point of the layout below. The rail used to be a column BESIDE this
                     one, which put the scrollbar between the document and the rail: a solid bar reporting
                     position, a few pixels from a lit border reporting position, in two visual languages. Now
                     the document keeps the room the rail occupies as PADDING, and the rail parks in it.

                     `ui-softscroll`, not `scrollbar-thin`: a whisper until the pointer is in the column, a real
                     thumb the moment it is: right for a surface being read rather than scanned. Its stable
                     gutter is also what makes the rail's inset below a constant.

                     THE LEFT PADDING IS A RAIL FOR THE MARKUP. Editing hangs a block's opening markers (`##`,
                     `- `, `> `) to the left of the text so revealing them moves nothing, and on a pane too narrow
                     for the reading column to be centred there is no margin for them to hang in: the hashes ran
                     off the edge. 48px is what the deepest marker needs, and it is spent in BOTH states, because
                     a column that moved when you pressed Edit would give back the jump this surface exists to
                     avoid. Same number, and the same reasoning, as VS Code's own editor content padding. -->
                <div
                    ref="scroller"
                    class="ui-softscroll h-full min-w-0 flex-1 overflow-auto bg-canvas py-5 pl-12"
                    :class="docked ? `pr-[18.5rem]` : `pr-6`"
                    @click="editing ? undefined : onPreviewClick($event)"
                >
                    <!-- The same document, twice over, in the same type. Reading is the app's one prose engine;
                         editing is that document rebuilt from its own source so the caret has something true to
                         stand in. Nothing about the switch between them is animated or measured, because with
                         the same rules styling both there is nothing to move. -->
                    <MarkdownDocumentSurface
                        v-if="editing"
                        ref="surface"
                        :key="path"
                        :source="doc"
                        :caret-at="landing"
                        @change="onChange"
                        @save="(value) => emit(`save`, value)"
                    />
                    <Markdown v-else :source="doc" :decorate="decorate" class="mx-auto max-w-3xl" />
                </div>
                <!-- Parked in that padding rather than laid out beside it, and OUTSIDE the scroller rather than
                     stuck to the top of it: pinned to the pane, it neither scrolls away with the document nor
                     slides sideways when a wide table scrolls, and `inset-y-0` hands it the visible height for
                     free, so its own list scrolls independently of the document's. `right` is the measured
                     scrollbar strip: the one number that keeps it clear of the bar without covering it.

                     NO BORDER ON THIS EDGE. The rows inside already draw a line down their left; a container
                     rule beside it was a second hairline drawing the same boundary twice. It carries the
                     canvas colour because content wider than the reading column scrolls underneath it. -->
                <aside
                    v-if="docked"
                    class="absolute inset-y-0 flex w-72 flex-col bg-canvas py-5 pl-2 pr-2"
                    :style="{ right: `${outline.gutter.value}px` }"
                >
                    <MarkdownOutline :headings="outline.headings.value" :active="outline.active.value" @jump="outline.jump" />
                </aside>
            </template>
            <!-- The escape hatch, editable on exactly the same terms as the document above. -->
            <CodeView
                v-else
                ref="sourceView"
                :key="path"
                class="min-w-0 flex-1"
                :code="doc"
                :path="path"
                lang="markdown"
                :editable="editable === true && layout.editMode.value"
                :scroll-to-line="line"
                @change="onChange"
                @save="(value) => emit(`save`, value)"
            />
        </div>

        <!-- The same outline, for the pane that cannot dock one (and for a peek at it after the rail is off).
             Anchored to the section button on a desktop, a sheet on a phone. -->
        <ResponsiveOverlay v-model="overlayOpen" :anchor="opener" header="Outline" panel-class="max-h-[60vh] w-72 p-2">
            <MarkdownOutline :headings="outline.headings.value" :active="outline.active.value" @jump="jumpFromOverlay" />
        </ResponsiveOverlay>
    </div>
</template>

<style scoped>
/* A task box is a control, not a word: it never takes the text cursor. */
:deep(.md-task-box) {
    cursor: pointer;
}
</style>
