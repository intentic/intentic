<!-- THE DOCUMENT, TYPED INTO DIRECTLY. The editing half of the markdown viewer.

     There is no editor widget here and nothing is swapped when you click. The whole document is one
     `contenteditable` whose text IS the markdown source (markdownSourceDom.ts), with the markup characters
     wrapped in spans the stylesheet hides. Putting the caret in a block adds a class to it; the class reveals
     that block's markers, which were in the layout all along. Nothing is torn down, nothing is measured, nothing
     moves.

     That is the difference from the surface this replaces, which mounted a Monaco editor in place of the clicked
     paragraph: a different font in a different box at a different size, arriving with a flicker, on every click.

     Caret, selection, IME and spellcheck are the browser's, which is the whole reason for building on
     `contenteditable` rather than on a widget. What the browser must NOT be trusted with is markup and
     whitespace, and it is not: every edit is read back as text and its blocks are built again from that text, so
     anything it inserts of its own is gone on the next pass, and the newlines it would quietly delete are held
     outside the DOM where it cannot reach them. See `built` and `makeEditable`.

     UNDO IS OURS TOO, and for the same reason: rebuilding a block is a programmatic DOM write, which drops the
     browser's own stack on the first keystroke. So is every shortcut that means markup rather than formatting,
     because there is no bold here to switch on, only asterisks to put around something. See markdownHistory.ts
     and markdownEdits.ts. -->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { splitMarkdownBlocks } from "@intentic/ui/markdown";
import { indentLines, insertLink, onListLine, outdentLines, type TextEdit, toggleWrap } from "./markdownEdits";
import { createMarkdownHistory, type EditKind } from "./markdownHistory";
import { blockBody, buildBlockElement, caretAtOffset, offsetOfCaret } from "./markdownSourceDom";
import "./markdownEditing.css";

const { source, caretAt } = defineProps<{ source: string; caretAt?: number }>();
const emit = defineEmits<{ change: [value: string]; save: [value: string] }>();

const host = ref<HTMLElement>();
/* The document as this surface last built it: one entry per block, holding the block's own text, the blank
 * lines that follow it, and the element drawing it.
 *
 * THE GAP IS HELD HERE AND NOT IN THE DOM, which is the one place this surface cannot take the browser at its
 * word. Those newlines have to collapse (they are structure, already said by the blocks they separate), and a
 * browser treats collapsed whitespace inside a `contenteditable` as spare: typing at the end of a paragraph
 * silently deleted the blank line after it, and the paragraph and the heading below it became one block. So the
 * DOM holds only what is VISIBLE, the gaps live here, and the source is the two put back together. */
let built: { body: string; gap: string; element: HTMLElement }[] = [];
let composing = false;
let syncing = false;

// The document, reassembled: what the DOM now says each block is, plus the gap that followed it. Read from the
// DOM's own children rather than from `built`, so a block the user JOINED to its neighbour (backspace at the
// start of one) correctly loses the gap between them instead of keeping a separator for a block that is gone.
const text = (): string => {
    const root = host.value;
    if (root === undefined) {
        return ``;
    }
    return [...root.children].map((element, index) => `${blockBody(element)}${built[index]?.gap ?? `\n\n`}`).join(``);
};

// The document's own children, which are the blocks. `built` mirrors them, but the DOM is the truth.
const blockElements = (): Element[] => [...(host.value?.children ?? [])];

// Where each block STARTS in the source: its own text plus the gap that follows it, accumulated.
const blockStarts = (): number[] => {
    let at = 0;
    return blockElements().map((element, index) => {
        const start = at;
        at += blockBody(element).length + (built[index]?.gap ?? `\n\n`).length;
        return start;
    });
};

// Which block the selection is in, by walking up to the child of the root that holds it.
const activeIndex = (): number => {
    const root = host.value;
    const selection = window.getSelection();
    const node = selection === null || selection.rangeCount === 0 ? undefined : selection.getRangeAt(0).startContainer;
    if (root === undefined || node === undefined || !root.contains(node)) {
        return -1;
    }
    return blockElements().findIndex((element) => element === node || element.contains(node));
};

/* A position in the DOM as an offset into the source. Resolved from the NODE rather than from the selection's
 * own start, so it answers for either end of a selection: the two ends can sit in different blocks, and a
 * shortcut that formats a selection needs both. */
const sourceOffsetOf = (node: Node, offset: number): number | undefined => {
    const root = host.value;
    if (root === undefined || !root.contains(node)) {
        return undefined;
    }
    const index = blockElements().findIndex((element) => element === node || element.contains(node));
    const element = blockElements()[index];
    if (element === undefined) {
        return undefined;
    }
    // Within the block from the DOM, and the blocks before it from `built`: the gaps are not in the DOM to be
    // counted, so they are added back here.
    return (blockStarts()[index] ?? 0) + offsetOfCaret(element as HTMLElement, node, offset);
};

const liveRange = (): Range | undefined => {
    const selection = window.getSelection();
    return selection === null || selection.rangeCount === 0 ? undefined : selection.getRangeAt(0);
};

/** Where the caret is, as an offset into the document's source. */
const caretOffset = (): number | undefined => {
    const range = liveRange();
    return range === undefined ? undefined : sourceOffsetOf(range.startContainer, range.startOffset);
};

/** The selection as source offsets, or undefined when it is not in this document. */
const selectionRange = (): { start: number; end: number } | undefined => {
    const range = liveRange();
    if (range === undefined) {
        return undefined;
    }
    const start = sourceOffsetOf(range.startContainer, range.startOffset);
    const end = sourceOffsetOf(range.endContainer, range.endOffset);
    return start === undefined || end === undefined ? undefined : { start: Math.min(start, end), end: Math.max(start, end) };
};

// The place in the DOM a source offset names, for putting a caret or a selection edge back after a rebuild.
const domPointAt = (offset: number): { node: Node; offset: number } | undefined => {
    const starts = blockStarts();
    const elements = blockElements();
    // The last block whose start is at or before the offset: where a caret sitting in a gap belongs is the end
    // of the block that gap follows, which is where the user was typing.
    let index = 0;
    for (let at = 0; at < starts.length; at += 1) {
        if ((starts[at] ?? 0) <= offset) {
            index = at;
        }
    }
    const element = elements[index];
    if (element === undefined) {
        return undefined;
    }
    const local = Math.min(offset - (starts[index] ?? 0), blockBody(element).length);
    return caretAtOffset(element as HTMLElement, Math.max(0, local));
};

const putSelection = (start: number, end: number): void => {
    const from = domPointAt(start);
    const to = domPointAt(end);
    if (from === undefined || to === undefined) {
        return;
    }
    const range = document.createRange();
    range.setStart(from.node, Math.min(from.offset, from.node.textContent?.length ?? 0));
    range.setEnd(to.node, Math.min(to.offset, to.node.textContent?.length ?? 0));
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
};

const putCaret = (offset: number): void => putSelection(offset, offset);

/* Which block the caret is in gets the class that reveals its markers. The same answer however the caret got
 * there: a click, an arrow key, a find, or the text under it being rewritten. */
const markActive = (): void => {
    const index = activeIndex();
    blockElements().forEach((element, at) => element.classList.toggle(`md-block-active`, at === index));
};

// A block's span, split into the part that is drawn and the blank lines that follow it (which are not).
const partsOf = (block: string): { body: string; gap: string } => {
    const gap = /\n*$/u.exec(block)?.[0] ?? ``;
    return { body: block.slice(0, block.length - gap.length), gap };
};

const render = (next: string): void => {
    const root = host.value;
    if (root === undefined) {
        return;
    }
    const { blocks } = splitMarkdownBlocks(next);
    root.replaceChildren();
    built = [];
    for (const block of blocks) {
        const part = partsOf(next.slice(block.start, block.end));
        const element = buildBlockElement(part.body);
        root.appendChild(element);
        built.push({ body: part.body, gap: part.gap, element });
    }
};

/* WHY `true` AND NOT `plaintext-only`, which is the obvious choice and the wrong one.
 *
 * `plaintext-only` would stop the browser inserting markup of its own, which is exactly the guarantee this
 * surface wants. But Chromium FORCES `white-space: pre-wrap` on a plaintext-only editing host, below the
 * cascade, where no stylesheet can reach it. This document's newlines are structure, already expressed by the
 * blocks they separate, so preserving them visually drew the blank line between two paragraphs as an actual
 * blank line (the document came out nearly twice its height) and broke a hard-wrapped paragraph at the source's
 * column instead of at the reading column. Whitespace has to collapse here, so the attribute has to be `true`.
 *
 * What `plaintext-only` was buying is bought instead by the rebuild: every edit is read back as text and its
 * blocks are built again from that text (see `sync`), so markup the browser inserts on its own, a `<b>` from a
 * formatting shortcut, a paste full of HTML, a `<div>` from a stray Enter, contributes nothing to `textContent`
 * and is thrown away on the next pass. The guards below stop it happening at all where that is cheap; the
 * rebuild is what makes it harmless where it is not. */
/* Rebuild the blocks whose source changed, and only those.
 *
 * The browser has already edited the DOM in place by the time this runs, so the text is right and only the
 * MARKUP is stale: an asterisk just typed is still a plain character until its block is parsed again. Rebuilding
 * only what changed is what keeps that reparse off the rest of the document, so typing in a long file costs the
 * paragraph being typed in rather than the file. */
const sync = (): void => {
    const root = host.value;
    if (root === undefined || composing) {
        return;
    }
    const current = text();
    const { blocks } = splitMarkdownBlocks(current);
    const wanted = blocks.map((block) => partsOf(current.slice(block.start, block.end)));
    const offset = caretOffset();
    // An empty block is a line the caret is standing on that the document does not contain (see startBlock).
    // Leave the layout alone while one exists: re-splitting would find one block fewer and rebuild it away,
    // taking the caret with it.
    const pending = blockElements().some((element) => blockBody(element) === ``);
    syncing = true;
    try {
        if (wanted.length !== built.length && pending) {
            // Nothing to do: the extra element is the empty line, and it is not the document's business.
        } else if (wanted.length !== built.length) {
            // A structural edit (a blank line typed, two blocks joined): the blocks no longer line up one to
            // one, so the cheapest correct answer is to lay them out again.
            root.replaceChildren();
            built = [];
            for (const part of wanted) {
                const element = buildBlockElement(part.body);
                root.appendChild(element);
                built.push({ body: part.body, gap: part.gap, element });
            }
        } else {
            wanted.forEach((part, index) => {
                const previous = built[index];
                if (previous === undefined) {
                    return;
                }
                if (previous.body !== part.body) {
                    const element = buildBlockElement(part.body);
                    previous.element.replaceWith(element);
                    built[index] = { body: part.body, gap: part.gap, element };
                    return;
                }
                built[index] = { body: previous.body, gap: part.gap, element: previous.element };
            });
        }
    } finally {
        syncing = false;
    }
    if (offset !== undefined) {
        putCaret(offset);
    }
    markActive();
};

/* THE UNDO STACK IS THIS SURFACE'S, because the browser's cannot survive what this surface does: parsing an edit
 * and rebuilding the block it changed is a programmatic DOM write, which drops the native stack on the first
 * keystroke. See markdownHistory.ts. */
const history = createMarkdownHistory();

// Note where the document has got to. Called after every edit, once the DOM has settled, so the caret recorded
// with it is the one the user will be returned to.
const remember = (kind: EditKind): void => history.record({ text: text(), caret: caretOffset() ?? 0 }, kind, Date.now());

/** Put `next` on screen, tell the world, and restore the selection the edit asks for. */
const apply = (edit: TextEdit, kind: EditKind = `structural`): void => {
    render(edit.text);
    emit(`change`, edit.text);
    putSelection(edit.start, edit.end);
    markActive();
    remember(kind);
};

// An edit's kind, from what the browser says it did. Insertions and deletions coalesce into runs of their own
// (see markdownHistory); anything else is a step by itself.
const kindOf = (inputType: string): EditKind =>
    inputType.startsWith(`insert`) ? `typing` : inputType.startsWith(`delete`) ? `deleting` : `structural`;

// What happens after the browser has edited the DOM: read the text back, reparse the blocks it changed, and note
// the step. One path, whether the edit came from a keystroke or from an IME committing a word.
const commitInput = (kind: EditKind): void => {
    emit(`change`, text());
    sync();
    remember(kind);
};

const onInput = (event: Event): void => {
    if (composing) {
        return;
    }
    commitInput(kindOf(event instanceof InputEvent ? event.inputType : ``));
};

/* An IME is mid-word: the DOM holds a composition the user has not committed, so reparsing it would rewrite the
 * text under their candidate list and lose it. Nothing happens until they accept. */
const onCompositionStart = (): void => {
    composing = true;
};

const onCompositionEnd = (): void => {
    composing = false;
    // A committed composition is a word arriving: typing, so it coalesces with the run around it.
    commitInput(`typing`);
};

/* Text spliced into the document at the caret, for the keys the browser would otherwise get wrong. Done to the
 * SOURCE and re-rendered rather than to the DOM through a range: the source is the thing that has to be right,
 * and going through it means the blocks are re-split by the same code path every other edit uses. */
const insertAtCaret = (insert: string): void => {
    // Over the SELECTION, not merely at the caret: pasting with words selected replaces them, which is what
    // every editor does and what the browser would have done if this were not intercepted.
    const at = selectionRange();
    if (at === undefined) {
        return;
    }
    const current = text();
    const next = current.slice(0, at.start) + insert + current.slice(at.end);
    apply({ text: next, start: at.start + insert.length, end: at.start + insert.length });
};

/* ENTER, AND WHY IT NEEDS A BLOCK THAT IS NOT IN THE FILE.
 *
 * Pressing Enter at the end of a paragraph should leave the caret on a new, empty line. Markdown has no
 * empty-paragraph construct, so that line cannot be represented as a block: inserting the blank line and
 * re-splitting gives back the SAME blocks with a wider gap between them, and the caret has nowhere to land but
 * the end of the paragraph it just left. (VS Code hit this too and answered it the same way, with a transient
 * paragraph its parser never sees.)
 *
 * So an empty block element is added to the DOM and not to the document. It carries the blank lines that follow
 * it, so the source still reads back correctly, and `sync` leaves any empty block alone until something is typed
 * into it, at which point it becomes an ordinary block like any other. Deleting a block's last character lands
 * in exactly the same state, and gets exactly the same treatment, which is what it should be: an empty paragraph
 * you can type in, that costs the file nothing until you do.
 *
 * Mid-block, none of this applies: splitting a paragraph in two produces two real blocks, so the source is
 * edited directly and the blocks fall out of the split.
 */
const startBlock = (): void => {
    const root = host.value;
    const index = activeIndex();
    const element = blockElements()[index];
    const offset = caretOffset();
    if (root === undefined || element === undefined || offset === undefined) {
        return;
    }
    const start = blockStarts()[index] ?? 0;
    const length = blockBody(element).length;
    if (offset > start && offset < start + length) {
        insertAtCaret(`\n\n`);
        return;
    }
    const at = offset === start ? index : index + 1;
    const blank = document.createElement(`p`);
    root.insertBefore(blank, root.children[at] ?? null);
    built.splice(at, 0, { body: ``, gap: `\n\n`, element: blank });
    const range = document.createRange();
    range.setStart(blank, 0);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    emit(`change`, text());
    markActive();
    remember(`structural`);
};

// Restore a state from the history stack. The whole document is laid out again: an undo can cross blocks, and
// putting it back wholesale is the one way the DOM and the source cannot end up disagreeing about it.
const travel = (state: { text: string; caret: number } | undefined): boolean => {
    if (state === undefined) {
        return false;
    }
    render(state.text);
    emit(`change`, state.text);
    putCaret(state.caret);
    markActive();
    return true;
};

/* A formatting shortcut, applied to whatever is selected. Returns false when there is no selection to act on, so
 * the caller can leave the key to the browser rather than swallowing it. */
const format = (edit: (text: string, start: number, end: number) => TextEdit): boolean => {
    const at = selectionRange();
    if (at === undefined) {
        return false;
    }
    apply(edit(text(), at.start, at.end));
    return true;
};

const onKeydown = (event: KeyboardEvent): void => {
    const chord = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();

    // An IME is mid-word. Every chord below would act on text the user has not committed yet.
    if (composing) {
        return;
    }

    if (chord && key === `s`) {
        event.preventDefault();
        emit(`save`, text());
        return;
    }

    /* UNDO AND REDO. Both spellings of redo, because both are in people's hands: Ctrl+Shift+Z everywhere, and
     * Ctrl+Y as well on Windows, where a generation of editors bound it. */
    if (chord && key === `z` && !event.shiftKey) {
        event.preventDefault();
        travel(history.undo());
        return;
    }
    if (chord && ((key === `z` && event.shiftKey) || key === `y`)) {
        event.preventDefault();
        travel(history.redo());
        return;
    }

    /* THE FORMATTING KEYS, as the markdown they mean. There is no "bold" to switch on here, there are two
     * asterisks to put around something, so Ctrl+B writes them and takes them away again. Doing it this way
     * rather than letting the browser's own `formatBold` run is what keeps the file readable: `<b>` would say
     * nothing markdown can express, and would vanish on the next rebuild anyway. */
    if (chord && !event.altKey && (key === `b` || key === `i` || key === `k`)) {
        const done = key === `k` ? format(insertLink) : format((body, start, end) => toggleWrap(body, start, end, key === `b` ? `**` : `*`));
        if (done) {
            event.preventDefault();
        }
        return;
    }

    /* TAB INDENTS A LIST, and only a list. Everywhere else it stays the key that leaves the document, which is
     * the only way out for someone navigating by keyboard: a text box that swallows Tab is a trap. */
    if (event.key === `Tab` && !chord && !event.altKey) {
        const at = selectionRange();
        if (at !== undefined && onListLine(text(), at.start)) {
            event.preventDefault();
            apply((event.shiftKey ? outdentLines : indentLines)(text(), at.start, at.end));
        }
        return;
    }

    /* SHIFT+ENTER IS A LINE BREAK INSIDE THE PARAGRAPH, which markdown spells as two trailing spaces before the
     * newline. Left to the browser it inserted a `<br>` carrying no source at all, so the break was gone on the
     * next rebuild: the key appeared to work and then undid itself.
     *
     * At the END of a block it starts a new one instead, because there markdown has nothing for it to mean: a
     * hard break needs a line to break TO, so the two spaces and the newline are trailing whitespace, which the
     * browser then collapses away exactly as it does everywhere else in this surface. Rather than write
     * characters that will not survive, the key does the visible thing the user was reaching for. */
    if (event.key === `Enter` && event.shiftKey && !chord && !event.altKey) {
        event.preventDefault();
        const at = selectionRange();
        const index = activeIndex();
        const element = blockElements()[index];
        const endOfBlock = at === undefined || element === undefined || at.end === (blockStarts()[index] ?? 0) + blockBody(element).length;
        if (endOfBlock) {
            startBlock();
        } else {
            insertAtCaret(`  \n`);
        }
        return;
    }
    /* ENTER STARTS A NEW BLOCK. In markdown a single newline inside a paragraph is a SPACE, so letting the
     * browser insert one would answer the most confident keypress in text editing with nothing visible
     * happening. What a writer means by Enter here is a new paragraph, which is a blank line, so that is what it
     * types. Shift+Enter is left alone and inserts the single newline, which is the soft break it means. */
    if (event.key === `Enter` && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        startBlock();
        return;
    }

    /* JOINING TWO BLOCKS, which the browser cannot do here because the thing between them is not in the DOM for
     * it to delete (see `built`). Left to it, Backspace at the start of a paragraph would eat the last character
     * of the paragraph above instead of the blank line between them, which is a silent, wrong edit. So the two
     * boundary presses are taken and answered against the source: the gap goes, the blocks become one, and the
     * caret sits at the seam. Every other Backspace and Delete is ordinary text editing and is left alone. */
    const joining = event.key === `Backspace` || event.key === `Delete`;
    if (!joining || event.ctrlKey || event.metaKey || event.altKey || window.getSelection()?.isCollapsed === false) {
        return;
    }
    const index = activeIndex();
    const element = blockElements()[index];
    if (element === undefined) {
        return;
    }
    const starts = blockStarts();
    const offset = caretOffset();
    const start = starts[index] ?? 0;
    const length = blockBody(element).length;
    const atStart = offset === start;
    const atEnd = offset === start + length;
    // Backspace at the very start joins with the block above; Delete at the very end joins with the one below.
    const seam = event.key === `Backspace` ? (atStart && index > 0 ? index - 1 : undefined) : atEnd && index < starts.length - 1 ? index : undefined;
    if (seam === undefined) {
        return;
    }
    event.preventDefault();
    const current = text();
    const gap = built[seam]?.gap ?? `\n\n`;
    const cut = (starts[seam] ?? 0) + blockBody(blockElements()[seam] ?? document.createElement(`p`)).length;
    apply({ text: current.slice(0, cut) + current.slice(cut + gap.length), start: cut, end: cut });
};

// The selection moves for reasons that are not edits (a click, an arrow key), and the active block has to follow
// it. Listened for on the document because that is the only place the event fires.
const onSelectionChange = (): void => {
    if (!syncing) {
        markActive();
    }
};

const makeEditable = (root: HTMLElement): void => {
    root.setAttribute(`contenteditable`, `true`);
    // Set here rather than in the template because what this element IS to a screen reader and to the
    // spellchecker belongs with the line that makes it editable, not scattered across the markup.
    root.setAttribute(`spellcheck`, `true`);
    root.setAttribute(`role`, `textbox`);
    root.setAttribute(`aria-multiline`, `true`);
};

// Paste is the text and only ever the text: a document's formatting lives in its markdown, so pasted styling
// would be a claim this file cannot make.
const onPaste = (event: ClipboardEvent): void => {
    event.preventDefault();
    insertAtCaret(event.clipboardData?.getData(`text/plain`) ?? ``);
};

const onDrop = (event: DragEvent): void => {
    event.preventDefault();
    insertAtCaret(event.dataTransfer?.getData(`text/plain`) ?? ``);
};

/* Two things the browser must not do here, refused at the door.
 *
 * `formatBold` and friends would wrap a `<b>` around the selection, which says nothing this file can hold. The
 * shortcuts are answered in `onKeydown` as the markdown they mean; this catches the other ways in, a context
 * menu or a touch-keyboard's formatting bar.
 *
 * `historyUndo` and `historyRedo` are the browser reaching for a stack that this surface invalidated the moment
 * it first rebuilt a block (see markdownHistory.ts). Letting it run would restore DOM the model knows nothing
 * about. Ctrl+Z is handled in `onKeydown`; this covers the menu and the trackpad gesture. */
const onBeforeInput = (event: InputEvent): void => {
    if (event.inputType.startsWith(`format`)) {
        event.preventDefault();
        return;
    }
    if (event.inputType === `historyUndo` || event.inputType === `historyRedo`) {
        event.preventDefault();
        travel(event.inputType === `historyUndo` ? history.undo() : history.redo());
    }
};

onMounted(() => {
    if (host.value !== undefined) {
        makeEditable(host.value);
    }
    render(source);
    document.addEventListener(`selectionchange`, onSelectionChange);
    if (caretAt !== undefined) {
        host.value?.focus({ preventScroll: true });
        putCaret(caretAt);
    }
    markActive();
    history.reset({ text: source, caret: caretAt ?? 0 });
});

// A new document (a different file, a reload from disk) replaces what is on screen; the surface's own edits come
// back through `change` and must never round-trip, so an unchanged text is ignored. History starts again with it:
// undoing past a file you did not edit into one you did is not something anyone means by Ctrl+Z.
watch(
    () => source,
    (next) => {
        if (next !== text()) {
            render(next);
            history.reset({ text: next, caret: 0 });
        }
    },
);

onBeforeUnmount(() => document.removeEventListener(`selectionchange`, onSelectionChange));

defineExpose({ text, focus: (): void => host.value?.focus() });
</script>

<template>
    <div
        ref="host"
        class="md-prose md-editing mx-auto max-w-3xl"
        aria-label="Document"
        @input="onInput"
        @beforeinput="onBeforeInput"
        @keydown="onKeydown"
        @paste="onPaste"
        @drop="onDrop"
        @compositionstart="onCompositionStart"
        @compositionend="onCompositionEnd"
    ></div>
</template>
