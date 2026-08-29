<script setup lang="ts">
import { ui, Icon, Markdown, MarkdownParts, ResponsiveOverlay, useNarrow } from "@intentic/ui";
import { blockAtOffset, type MarkdownDecorator, offsetOfLine, splitMarkdownBlocks } from "@intentic/ui/markdown";
import { computed, nextTick, ref, watch } from "vue";
import { fileLinkDecorator } from "../../../composables/renderMarkdown";
import { useLayout } from "../../../composables/useLayout";
import { openFileRefFromEvent } from "../../../composables/workspace/openFileRef";
import { workspaceAgent } from "../../../composables/workspace/workspaceScope";
import type { LineJump } from "../workspaceTabs";
import CodeView from "./CodeView.vue";
import MarkdownBlockEditor from "./MarkdownBlockEditor.vue";
import MarkdownOutline from "./MarkdownOutline.vue";
import { blockText, caretOffsetInSource, createBlockRenderer, shiftOffset, spliceBlock, toggleTaskCheckbox } from "./markdownEditing";
import { useMarkdownOutline } from "./markdownOutline";

/* THE MARKDOWN SURFACE: prose you can type into, with a lock rather than a mode switch.
 *
 * WHY NOT A PREVIEW/EDIT TOGGLE. Every other file in this app has one honest form (its source), so the viewer's
 * global Edit switch is the whole story for them. A markdown file has TWO, and the rendered one is the one
 * people read; a toggle between them says the two are alternatives you pick between, when what a writer actually
 * does is read a document and fix a sentence in it. So markdown opts out of that switch entirely (FileViewer
 * hides it here) and gets a LOCK instead: prose either way, and the only thing the lock changes is whether
 * clicking a paragraph opens its markdown and whether keystrokes land. That is VS Code's answer too, arrived at
 * from the same place: their hybrid markdown editor renders in both states and carries a lock in the corner,
 * defaulted closed, remembered globally, with "reopen as source" left as the way out.
 *
 * WHAT UNLOCKING BUYS. Clicking a paragraph turns THAT paragraph into its markdown (MarkdownBlockEditor) and
 * leaves the rest of the document rendered, so you edit in the document you were reading rather than in a
 * screen of source that has to be navigated back to. Blocks are the unit because they are the unit the parser
 * already has (markdownEditing.ts); a caret arrowed off the top or bottom of one moves into the next, so the
 * page still behaves like one document.
 *
 * WHAT STAYS. The outline rail no longer disappears the moment you start editing, which is the practical reason
 * the old switch hurt: a long document lost its navigation exactly when restructuring it. The Source view stays
 * as the escape hatch it should have been all along, editable, and it is the only place where the blank lines
 * BETWEEN blocks can be changed: a block editor is never shown them, so an ordinary edit cannot pull a document
 * apart by deleting the gap that separates two paragraphs.
 *
 * TICKING A BOX IS NOT EDITING. Task checkboxes stay live even while locked. It is a fact about the work, not a
 * change to the prose, every other checklist in the app is clickable, and the plans agents write here are full
 * of them. Same line VS Code draws. */

// `line` = a content-search match landing here. `editable` is the host's permission (never in a conversation's
// copy of the workspace, never on mobile, never over the editable size cap), not the reader's lock.
const { source, path, line, editable } = defineProps<{ source: string; path: string; line?: LineJump; editable?: boolean }>();
const emit = defineEmits<{ change: [value: string]; save: [value: string] }>();

const layout = useLayout();

/* THE DOCUMENT, HELD RATHER THAN WATCHED, exactly like the editable CodeView beside it: `source` is a SEED, and
 * the surface owns the text from mount onwards. FileViewer re-keys this component whenever disk wins (a reload,
 * an external write with no local changes, a file switch), which is the one signal that should ever replace what
 * the user has typed. Watching the prop instead would fight the buffer: every keystroke is reported upwards and
 * comes back down through it. */
const doc = ref(source);
// The block being edited, and the text its editor currently holds. `pending` is deliberately NOT spliced into
// `doc` on every keystroke: re-splitting the document under a live caret would move the block out from under it
// the moment a keystroke changed the block structure. It is spliced for reporting (below) and on commit.
const active = ref<number | undefined>(undefined);
const pending = ref<string | undefined>(undefined);
const caret = ref(0);

/* Past this, prose is not what a reader gets: it is a frozen tab. Rendering is one synchronous pass of
 * marked → DOMPurify → the file-link walk → serialize → v-html, and then the browser lays out the result:
 * measured on a 1.9 MiB document, ~500ms of script and 1283ms of layout for 77k nodes. Source view is Monaco,
 * which renders only the lines on screen, so it opens instantly at any size. */
const PROSE_MAX_CHARS = 256 * 1024;
const heavy = source.length > PROSE_MAX_CHARS;
const view = ref<`preview` | `source`>(heavy ? `source` : `preview`);

// The reader's lock, remembered across documents (useLayout). A file the host will not let anyone write is
// locked whatever the preference says, so the affordance never promises an edit that cannot land.
const locked = computed(() => editable !== true || layout.markdownLocked.value);
const editing = computed(() => view.value === `preview` && !locked.value);

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

const split = computed(() => splitMarkdownBlocks(doc.value));
// One renderer per file: its cache is what makes moving the caret from one paragraph to the next cost the two
// blocks that changed rather than the document around them (markdownEditing.ts).
const renderer = computed(() => createBlockRenderer(decorate.value));
const parts = computed(() => renderer.value.parts(doc.value, split.value.blocks, split.value.defs, active.value));

// The document as it stands INCLUDING the open block's unsaved text: what the file's dirty state and a save are
// about. Never what the surface renders, which is `doc` with a hole where the editor is.
const liveDoc = (): string => {
    const block = active.value === undefined ? undefined : split.value.blocks[active.value];
    return block === undefined || pending.value === undefined ? doc.value : spliceBlock(doc.value, block, pending.value);
};

/* Fold the open block's text back into the document and close it. A caller that measured something against the
 * document as it stood BEFORE this (a click on a later paragraph) compares `doc.value.length` either side to
 * learn how far the rest of the text moved; see onProseClick. */
const commit = (): void => {
    const index = active.value;
    const text = pending.value;
    const block = index === undefined ? undefined : split.value.blocks[index];
    active.value = undefined;
    pending.value = undefined;
    if (block === undefined || text === undefined) {
        return;
    }
    const next = spliceBlock(doc.value, block, text);
    if (next === doc.value) {
        return; // Opened and closed without typing anything: not an edit, and not the file's dirty state.
    }
    doc.value = next;
    emit(`change`, next);
};

// Open `index` with the caret `at` characters into its text. Committing first is what makes clicking straight
// from one paragraph to another work.
const open = (index: number, at: number): void => {
    const block = split.value.blocks[index];
    if (block === undefined) {
        return;
    }
    caret.value = Math.max(0, Math.min(at, blockText(doc.value, block).length));
    pending.value = undefined;
    active.value = index;
};

const openAtOffset = (offset: number): void => {
    const index = blockAtOffset(split.value.blocks, offset);
    const block = split.value.blocks[index];
    if (block !== undefined) {
        open(index, offset - block.start);
    }
};

const scroller = ref<HTMLElement>();
const outline = useMarkdownOutline(scroller);

/* WHERE IN THE SOURCE A CLICK LANDED. The rendered text before the pointer is read straight off the DOM (a range
 * from the top of the prose to the caret position under the pointer) and looked up in the markdown behind it,
 * see caretOffsetInSource. Reading it from the DOM rather than mapping element→block is what keeps this working
 * identically whether the document is drawn as one render or as blocks around an open editor. */
const offsetUnderPointer = (event: MouseEvent): number | undefined => {
    const root = scroller.value?.querySelector(`.md-prose`);
    if (root === null || root === undefined) {
        return undefined;
    }
    const caretRange =
        typeof document.caretRangeFromPoint === `function`
            ? document.caretRangeFromPoint(event.clientX, event.clientY)
            : (() => {
                  const position = document.caretPositionFromPoint?.(event.clientX, event.clientY);
                  if (position === null || position === undefined) {
                      return null;
                  }
                  const made = document.createRange();
                  made.setStart(position.offsetNode, position.offset);
                  return made;
              })();
    if (caretRange === null) {
        return undefined;
    }
    const upTo = document.createRange();
    upTo.setStart(root, 0);
    upTo.setEnd(caretRange.startContainer, caretRange.startOffset);
    return caretOffsetInSource(upTo.toString(), doc.value);
};

const onProseClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
        return;
    }
    // A task box is a control, and works locked: it is the reader's answer about the work, not an edit to prose.
    if (target instanceof HTMLInputElement && target.type === `checkbox`) {
        event.preventDefault();
        const boxes = [...(scroller.value?.querySelectorAll(`.md-prose input[type="checkbox"]`) ?? [])];
        const next = toggleTaskCheckbox(liveDoc(), boxes.indexOf(target));
        if (next !== undefined) {
            commit();
            doc.value = next;
            emit(`change`, next);
        }
        return;
    }
    // A link opens the file (or the page) it names, in both states, and never places a caret.
    openFileRefFromEvent(event);
    if (target.closest(`a`) !== null) {
        return;
    }
    // Locked, the click's only lasting effect is that the keyboard now reaches this surface, which is what lets
    // a keystroke be answered with the nudge above instead of with silence.
    if (!editing.value) {
        scroller.value?.focus({ preventScroll: true });
        return;
    }
    // Mid-drag of a selection: the reader is copying, not placing a caret.
    if (window.getSelection()?.isCollapsed === false) {
        return;
    }
    const offset = offsetUnderPointer(event);
    if (offset === undefined) {
        return;
    }
    // Measured against the document as it stands BEFORE the open block folds back in, so it has to be carried
    // across that edit (shiftOffset) or clicking a paragraph below the one being edited lands short.
    const index = active.value;
    const block = index === undefined ? undefined : split.value.blocks[index];
    const before = doc.value.length;
    commit();
    openAtOffset(block === undefined ? offset : shiftOffset(block, doc.value.length - before, offset));
};

/* TYPING WHILE LOCKED SAYS SO. Straight from VS Code, which flashes its own lock for the same reason: a person
 * who starts typing into a locked document has already told you what they want, and answering with nothing at
 * all reads as a broken keyboard. The nudge points at the control that grants it rather than granting it.
 *
 * The keystroke only arrives because the scroller TAKES FOCUS when the prose is clicked (`tabindex="-1"`, so it
 * is focusable without joining the tab order). A plain scrolling div receives no key events at all, which is why
 * this listener silently never ran: the keys were going to the body. Focusing on the click rather than on mount
 * is deliberate, a surface that grabs focus when a file opens takes it away from the chat composer. */
const nudging = ref(false);
const onProseKeydown = (event: KeyboardEvent): void => {
    if (editable !== true || !locked.value || event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1) {
        return;
    }
    nudging.value = false;
    void nextTick(() => (nudging.value = true));
};

const unlock = (): void => {
    nudging.value = false;
    layout.setMarkdownLocked(!layout.markdownLocked.value);
};

// Leaving a block by keyboard: `out` gives the document back, up/down step to the neighbour and land the caret
// at the near end of it, which is where an arrow key crossing a boundary should put it.
const onLeave = (direction: "up" | "down" | "out"): void => {
    const index = active.value;
    commit();
    if (direction === `out` || index === undefined) {
        return;
    }
    const next = index + (direction === `up` ? -1 : 1);
    const block = split.value.blocks[next];
    if (block !== undefined) {
        open(next, direction === `up` ? blockText(doc.value, block).length : 0);
    }
};

// The toolbar's Save and Ctrl+S from inside a block are the same act: fold the open block in, then save what the
// file now is. Exposed so FileViewer's own Save button saves through here too.
const save = (): void => {
    commit();
    emit(`save`, doc.value);
};
const sourceView = ref<InstanceType<typeof CodeView>>();
defineExpose({ save: (): void => (view.value === `source` ? (sourceView.value?.save() ?? undefined) : save()) });

/* A content-search hit is about a LINE, which rendered prose has no stable mapping for. Unlocked there is one
 * after all (the blocks carry source offsets), so the hit opens its own paragraph for editing; locked, it still
 * goes to the source view, which is the honest answer when the surface cannot point at a line. */
watch(
    () => line,
    (next) => {
        if (next === undefined) {
            return;
        }
        if (editing.value) {
            openAtOffset(offsetOfLine(doc.value, next.line));
            return;
        }
        view.value = `source`;
    },
    { immediate: true },
);

// Locking mid-edit folds the open block back in rather than dropping it on the floor; so does leaving for the
// source view, which would otherwise show a file that disagrees with the paragraph still open behind it.
watch([locked, view], () => commit());

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
        <div class="relative flex shrink-0 items-center gap-2 border-b border-line px-2 py-1.5">
            <!-- THE LOCK. Two states, both of them prose: this is not a choice between two views of the file,
                 it is whether the file answers the keyboard. Absent where the host will not accept a write at
                 all, so it never offers an edit that cannot land. -->
            <button
                v-if="editable && view === `preview`"
                type="button"
                class="inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-1 text-2xs transition-colors"
                :class="[
                    locked ? `border-line text-muted hover:bg-overlay hover:text-content` : `border-link/40 bg-primary-600/15 text-link`,
                    nudging ? `md-lock-nudge` : ``,
                ]"
                :aria-pressed="!locked"
                v-tooltip.bottom="locked ? `Read-only: click to edit this document in place` : `Editing: click to lock`"
                @animationend="nudging = false"
                @click="unlock"
            >
                <Icon :name="locked ? `lock` : `pencil`" class="text-[0.7rem]" />
                <span class="max-md:hidden">{{ locked ? `Locked` : `Editing` }}</span>
            </button>

            <!-- The section the reader is in. A button rather than a label because the list behind it is what
                 they want next often enough to be worth the press, and on a pane too narrow to dock the rail,
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
                :class="ui.iconButton()"
                :aria-pressed="docked"
                v-tooltip.bottom="docked ? `Hide outline` : `Show outline`"
                :aria-label="docked ? `Hide outline` : `Show outline`"
                @click="layout.toggleMarkdownOutline()"
            >
                <Icon name="align-left" />
            </button>

            <!-- THE WAY OUT, not half of a toggle. The rendered document is where this file is read and written;
                 source is for the things prose cannot express, the blank line between two blocks, a construct the
                 renderer swallowed, a line a search matched. -->
            <button
                type="button"
                :class="ui.iconButton()"
                :aria-pressed="view === `source`"
                v-tooltip.bottom="view === `source` ? `Back to the document` : `View markdown source`"
                :aria-label="view === `source` ? `Back to the document` : `View markdown source`"
                @click="view = view === `source` ? `preview` : `source`"
            >
                <Icon :name="view === `source` ? `eye` : `code`" />
            </button>

            <!-- HOW MUCH IS LEFT, drawn over the toolbar's own bottom rule rather than as a bar of its own: a
                 reading position is a hairline's worth of information and does not deserve a row. Absent while
                 the document fits its pane: a full-width accent line under the toolbar of a short file reads
                 as a progress bar that finished, which is a claim about loading, not about reading. -->
            <div
                v-if="view === `preview` && outline.scrollable.value"
                class="pointer-events-none absolute -bottom-px left-0 h-px bg-link/60"
                :style="{ width: `${outline.progress.value * 100}%` }"
                aria-hidden="true"
            ></div>
        </div>

        <div class="relative flex min-h-0 flex-1">
            <template v-if="view === `preview`">
                <!-- THE SCROLLER SPANS THE WHOLE PANE, so its scrollbar sits at the pane's outermost edge:
                     which is the entire point of the layout below. The rail used to be a column BESIDE this
                     one, which put the scrollbar between the document and the rail: a solid bar reporting
                     position, a few pixels from a lit border reporting position, in two visual languages. Now
                     the document keeps the room the rail occupies as PADDING, and the rail parks in it.

                     `ui-softscroll`, not `scrollbar-thin`: a whisper until the pointer is in the column, a real
                     thumb the moment it is: right for a surface being read rather than scanned. Its stable
                     gutter is also what makes the rail's inset below a constant. -->
                <div
                    ref="scroller"
                    class="ui-softscroll h-full min-w-0 flex-1 overflow-auto bg-canvas py-5 pl-6 outline-none"
                    :class="[docked ? `pr-[18.5rem]` : `pr-6`, editing ? `md-editable` : ``]"
                    tabindex="-1"
                    @click="onProseClick"
                    @keydown="onProseKeydown"
                >
                    <!-- Two renderings of the same document, and the seam between them is PERMISSION, not the
                         lock: a file nobody may write is drawn in one pass, and one that may be written is drawn
                         block by block so a click can open any of them. The lock never changes which of these is
                         on screen, which is why locking and unlocking moves nothing. -->
                    <MarkdownParts v-if="editable" :parts="parts" class="mx-auto max-w-3xl">
                        <template #slot>
                            <MarkdownBlockEditor
                                :key="active"
                                :text="active === undefined ? `` : blockText(doc, split.blocks[active]!)"
                                :caret="caret"
                                @change="
                                    (value) => {
                                        pending = value;
                                        emit(`change`, liveDoc());
                                    }
                                "
                                @save="save"
                                @leave="onLeave"
                            />
                        </template>
                    </MarkdownParts>
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
            <!-- The escape hatch, editable on exactly the same terms as the document: the blank lines between
                 blocks live only here, and so does anything the renderer cannot show. -->
            <CodeView
                v-else
                ref="sourceView"
                class="min-w-0 flex-1"
                :key="path"
                :code="doc"
                :path="path"
                lang="markdown"
                :editable="editable && !layout.markdownLocked.value"
                :scroll-to-line="line"
                @change="
                    (value) => {
                        doc = value;
                        emit(`change`, value);
                    }
                "
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
/* The paragraph under the pointer is the one a click would open, so it says so before the click. A background
   rather than an outline: an outline would move nothing but still draw a box the rendered document does not
   have, and the point of this surface is that reading and editing look like the same page. */
.md-editable :deep(.md-run:hover) {
    background: color-mix(in srgb, var(--color-content) 4%, transparent);
    border-radius: 4px;
    box-shadow: 0 0 0 6px color-mix(in srgb, var(--color-content) 4%, transparent);
}

.md-editable :deep(.md-run) {
    cursor: text;
}

/* A task box is a control in both states: it never takes the text cursor, and it stays clickable while the rest
   of the document is locked. */
:deep(.md-task-box) {
    cursor: pointer;
}

/* The nudge: one pulse of the lock's own accent when a keystroke lands on a locked document. Short, and it does
   not move the button, a control that jumps under the pointer is a control you then have to re-aim at. */
.md-lock-nudge {
    animation: md-lock-nudge 320ms ease-out;
}

@keyframes md-lock-nudge {
    50% {
        border-color: var(--color-link);
        background: color-mix(in srgb, var(--color-link) 18%, transparent);
        color: var(--color-link);
    }
}

@media (prefers-reduced-motion: reduce) {
    .md-lock-nudge {
        animation: none;
    }
}
</style>
