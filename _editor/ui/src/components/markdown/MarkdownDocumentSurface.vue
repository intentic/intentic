<!--
    The editing half of <MarkdownDocument>: one `contenteditable` whose text is the markdown source (markdownSourceDom.ts), with markup characters
    hidden until the caret enters their block. Every edit is read back as text and blocks rebuilt from it; undo and markup shortcuts are implemented
    here, not by the browser.
-->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { continueList, indentLines, insertLink, onListLine, outdentLines, type TextEdit, toggleWrap } from "../../markdown/edits.js";
import { createMarkdownHistory, type EditKind } from "../../markdown/history.js";
import { splitMarkdownBlocks } from "../../markdown/index.js";
import { blockBody, buildBlockElement, caretAtOffset, offsetOfCaret } from "../../markdown/sourceDom.js";

const { source, caretAt } = defineProps<{ source: string; caretAt?: number }>();
const emit = defineEmits<{ change: [value: string]; save: [value: string] }>();

const host = ref<HTMLElement>();
// Last-built blocks: each entry's text, trailing blanks (held here, since the DOM collapses them), and element.
let built: { body: string; gap: string; element: HTMLElement }[] = [];
let composing = false;
let syncing = false;

// Reassembled from the DOM's children, not `built`, so a joined block loses the right gap, not an orphaned one.
const text = (): string => {
    const root = host.value;
    if (root === undefined) {
        return ``;
    }
    return [...root.children].map((element, index) => `${blockBody(element)}${built[index]?.gap ?? `\n\n`}`).join(``);
};

// The document's own children, which are the blocks. `built` mirrors them, but the DOM is the truth.
const blockElements = (): Element[] => [...(host.value?.children ?? [])];

// Where each block starts in the source: accumulated text length plus its trailing gap.
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

// DOM position as a source offset, resolved from a node, not the selection start, so it works for either end.
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
    // Block text comes from the DOM; blocks before it come from `built`, since gaps aren't in the DOM to count.
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
    // Last block whose start is at or before the offset: a caret in a gap belongs at the block before it.
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

// Marks whichever block holds the caret, regardless of how it got there (click, arrow key, find, rewrite).
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

// `contenteditable=true`, not `plaintext-only`: Chromium forces `white-space:pre-wrap` on plaintext-only below the
// cascade, rendering this document's structural newlines as visible blank lines.
// Rebuilds only the blocks whose text actually changed: the DOM's text is already right, only its markup is stale, so a
// long file's typing cost is one paragraph, not the whole document.
const sync = (): void => {
    const root = host.value;
    if (root === undefined || composing) {
        return;
    }
    const current = text();
    const { blocks } = splitMarkdownBlocks(current);
    const wanted = blocks.map((block) => partsOf(current.slice(block.start, block.end)));
    const offset = caretOffset();
    // An empty block (the caret's transient line) is left alone; re-splitting would find one fewer block and rebuild it
    // away.
    const pending = blockElements().some((element) => blockBody(element) === ``);
    syncing = true;
    try {
        if (wanted.length !== built.length && pending) {
            // Nothing to do: the extra element is the empty line, and it is not the document's business.
        } else if (wanted.length !== built.length) {
            // A structural edit (blank line, blocks joined): counts no longer line up, so the cheapest fix is relaying
            // out.
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

// Own undo stack: rebuilding a block is a DOM write, which drops the browser's native stack immediately.
const history = createMarkdownHistory();

// Records document state after each edit, once settled, so the caret recorded is the one to return to.
const remember = (kind: EditKind): void => history.record({ text: text(), caret: caretOffset() ?? 0 }, kind, Date.now());

/** Put `next` on screen, tell the world, and restore the selection the edit asks for. */
const apply = (edit: TextEdit, kind: EditKind = `structural`): void => {
    render(edit.text);
    emit(`change`, edit.text);
    putSelection(edit.start, edit.end);
    markActive();
    remember(kind);
};

// An edit's kind from the browser; insertions/deletions coalesce into runs, everything else its own step.
const kindOf = (inputType: string): EditKind =>
    inputType.startsWith(`insert`) ? `typing` : inputType.startsWith(`delete`) ? `deleting` : `structural`;

// After any edit: read the text back, reparse changed blocks, record the step. One path for keystroke or IME.
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

// IME mid-word: reparsing now would rewrite text under the candidate list; nothing happens until committed.
const onCompositionStart = (): void => {
    composing = true;
};

const onCompositionEnd = (): void => {
    composing = false;
    // A committed composition is a word arriving: typing, so it coalesces with the run around it.
    commitInput(`typing`);
};

// Splices into the source and re-renders, not the DOM, so it takes the same re-split path as every edit.
const insertAtCaret = (insert: string): void => {
    // Over the selection, not just the caret: replaces selected words, as the browser would have if left alone.
    const at = selectionRange();
    if (at === undefined) {
        return;
    }
    const current = text();
    const next = current.slice(0, at.start) + insert + current.slice(at.end);
    apply({ text: next, start: at.start + insert.length, end: at.start + insert.length });
};

// Enter at a paragraph's end needs a caret-only line markdown can't represent as a block, so an empty element is added
// to the DOM but not the document, left alone until typed into. Mid-block Enter just splits the paragraph in two.
/** The caret at the very start of an element, for a block that has no source offset to aim at yet. */
const caretInto = (element: HTMLElement): void => {
    const range = document.createRange();
    range.setStart(element, 0);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
};

// Widens a block's trailing gap to a blank line, so a transient paragraph after it starts a real paragraph instead of a
// CommonMark lazy continuation onto the item above.
const separate = (index: number): void => {
    const above = built[index];
    if (above !== undefined && !above.gap.includes(`\n\n`)) {
        built[index] = { ...above, gap: `\n\n` };
    }
};

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
    separate(at - 1);
    const blank = document.createElement(`p`);
    root.insertBefore(blank, root.children[at] ?? null);
    built.splice(at, 0, { body: ``, gap: `\n\n`, element: blank });
    caretInto(blank);
    emit(`change`, text());
    markActive();
    remember(`structural`);
};

// Restores history by re-laying out the document: an undo can cross blocks, so a partial patch could disagree.
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

// Applies a formatting shortcut to the selection; returns false with no selection, so the caller lets the browser
// handle the key.
const format = (edit: (text: string, start: number, end: number) => TextEdit): boolean => {
    const at = selectionRange();
    if (at === undefined) {
        return false;
    }
    apply(edit(text(), at.start, at.end));
    return true;
};

// Ctrl+B/I/K write the markdown characters directly (asterisks, a link), not the browser's own `formatBold`: a `<b>`
// means nothing here and would vanish on rebuild.
const onFormatKey = (event: KeyboardEvent, key: string): boolean => {
    if (event.altKey || (key !== `b` && key !== `i` && key !== `k`)) {
        return false;
    }
    if (key === `k` ? format(insertLink) : format((body, start, end) => toggleWrap(body, start, end, key === `b` ? `**` : `*`))) {
        event.preventDefault();
    }
    return true;
};

// Save, undo/redo, and formatting keys, split out of `onKeydown` since that handler otherwise mixes three unrelated
// questions. Each returns whether it claimed the key.
const onChordKey = (event: KeyboardEvent, key: string): boolean => {
    if (key === `s`) {
        event.preventDefault();
        emit(`save`, text());
        return true;
    }

    // Both redo spellings are bound: Ctrl+Shift+Z everywhere, plus Ctrl+Y from a generation of Windows editors.
    if (key === `z` && !event.shiftKey) {
        event.preventDefault();
        travel(history.undo());
        return true;
    }
    if ((key === `z` && event.shiftKey) || key === `y`) {
        event.preventDefault();
        travel(history.redo());
        return true;
    }

    return onFormatKey(event, key);
};

// Shift+Enter writes markdown's trailing-space line break; at a block's end that has nothing to break into, so it
// starts a new block instead of writing whitespace that would just collapse away.
const softBreak = (): void => {
    const at = selectionRange();
    const index = activeIndex();
    const element = blockElements()[index];
    const endOfBlock = at === undefined || element === undefined || at.end === (blockStarts()[index] ?? 0) + blockBody(element).length;
    if (endOfBlock) {
        startBlock();
    } else {
        insertAtCaret(`  \n`);
    }
};

// Enter starts a new block (a blank line), since a single newline in markdown is just a space and would type invisibly.
// On a list it opens the next item instead (`continueList`).
// Tab indents a list only; everywhere else it must stay the keyboard's way out of the document.
const onTabKey = (event: KeyboardEvent): void => {
    const at = selectionRange();
    if (at !== undefined && onListLine(text(), at.start)) {
        event.preventDefault();
        apply((event.shiftKey ? outdentLines : indentLines)(text(), at.start, at.end));
    }
};

const onEnterKey = (event: KeyboardEvent): void => {
    event.preventDefault();
    if (event.shiftKey) {
        softBreak();
        return;
    }
    const at = selectionRange();
    const continued = at?.start === at?.end && at !== undefined ? continueList(text(), at.start) : undefined;
    if (continued === undefined) {
        startBlock();
        return;
    }
    apply(continued.edit);
    // Leaving a list removes the marker; the caret needs a non-item line to land on, which `startBlock` provides.
    if (continued.ended) {
        startBlock();
    }
};

const onStructureKey = (event: KeyboardEvent): boolean => {
    if (event.altKey) {
        return false;
    }
    if (event.key === `Tab`) {
        onTabKey(event);
        return true;
    }
    if (event.key === `Enter`) {
        onEnterKey(event);
        return true;
    }
    return false;
};

// Which gap a boundary delete closes: Backspace at a block's start closes the gap above, Delete at its end closes the
// one below.
const seamAt = (key: string): number | undefined => {
    const index = activeIndex();
    const element = blockElements()[index];
    if (element === undefined) {
        return undefined;
    }
    const starts = blockStarts();
    const start = starts[index] ?? 0;
    const offset = caretOffset();
    const seam = key === `Backspace` ? (offset === start ? index - 1 : -1) : offset === start + blockBody(element).length ? index : -1;
    return seam >= 0 && seam < starts.length - 1 ? seam : undefined;
};

/** The document with the gap after block `seam` taken out, and the caret at the join. */
const joinAt = (seam: number): TextEdit => {
    const gap = (built[seam]?.gap ?? `\n\n`).length;
    const element = blockElements()[seam];
    const cut = (blockStarts()[seam] ?? 0) + (element === undefined ? 0 : blockBody(element).length);
    const current = text();
    return { text: current.slice(0, cut) + current.slice(cut + gap), start: cut, end: cut };
};

// Joins two blocks by editing the source directly: the gap between them isn't in the DOM, so an unhandled Backspace
// there would silently eat the wrong character instead.
const onJoinKey = (event: KeyboardEvent): void => {
    const deleting = event.key === `Backspace` || event.key === `Delete`;
    if (!deleting || event.altKey || window.getSelection()?.isCollapsed === false) {
        return;
    }
    const seam = seamAt(event.key);
    if (seam !== undefined) {
        event.preventDefault();
        apply(joinAt(seam));
    }
};

const onKeydown = (event: KeyboardEvent): void => {
    // An IME is mid-word. Every key below would act on text the user has not committed yet.
    if (composing) {
        return;
    }
    if (event.ctrlKey || event.metaKey) {
        onChordKey(event, event.key.toLowerCase());
        return;
    }
    if (!onStructureKey(event)) {
        onJoinKey(event);
    }
};

// Selection moves without an edit (click, arrow key); listened for on the document, the only place this event fires.
const onSelectionChange = (): void => {
    if (!syncing) {
        markActive();
    }
};

const makeEditable = (root: HTMLElement): void => {
    root.setAttribute(`contenteditable`, `true`);
    // Set here, not the template: what this element is to a screen reader belongs with the editable-making line.
    root.setAttribute(`spellcheck`, `true`);
    root.setAttribute(`role`, `textbox`);
    root.setAttribute(`aria-multiline`, `true`);
};

// Paste is the text and only the text: a document's formatting lives in its markdown, so pasted styling is not a claim
// this file can make.
const onPaste = (event: ClipboardEvent): void => {
    event.preventDefault();
    insertAtCaret(event.clipboardData?.getData(`text/plain`) ?? ``);
};

const onDrop = (event: DragEvent): void => {
    event.preventDefault();
    insertAtCaret(event.dataTransfer?.getData(`text/plain`) ?? ``);
};

// Refuses `formatBold`-style commands (a `<b>` this file can't hold) from a context menu or touch bar, and
// `historyUndo`/`historyRedo`, which would restore DOM this surface's own rebuilds already invalidated.
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

// A new document replaces the screen; the surface's own edits are ignored there, unchanged; history resets too.
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
    <!--
        No measure or centering of its own; the caller sets `--prose-measure` (`md-prose` reads it), so this surface
        and the rendered half beside it always agree. Caller's `class` lands here through fallthrough.
    -->
    <div
        ref="host"
        class="md-prose md-editing"
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
