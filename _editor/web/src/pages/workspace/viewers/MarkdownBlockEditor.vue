<!-- ONE BLOCK'S MARKDOWN, AS SOURCE, in the place its prose was standing.

     This is the editing half of the pretty-editing surface: the reader clicks a paragraph, that paragraph turns
     into its own markdown, and everything around it stays rendered. Monaco rather than a textarea or a
     contenteditable, for the reason the rest of this app uses Monaco: undo, IME, multi-cursor, bracket matching,
     paste and every keybinding a text editor is expected to have are already correct in it, and markdown is one
     of the grammars the surface next door already loads.

     IT IS SIZED BY ITS CONTENT, never scrolled. A block editor with its own scrollbar would be a little window
     onto a paragraph inside a document that also scrolls, and the reader would have two places to be lost in.
     So the host grows and shrinks with the text (onDidContentSizeChange) and the page scroll stays the only one.

     THE CARET CROSSES THE EDGES. Up on the top ROW and Down on the bottom one leave for the neighbouring block
     rather than doing nothing, which is what keeps a document that is half prose and half editor feeling like
     ONE document: you arrow through it. Rows, not source lines, because prose wraps, see the handler below.
     Escape hands the document back without committing anything different from what blurring would; it is the
     keyboard's way out, not an undo. -->
<script setup lang="ts">
import type * as Monaco from "monaco-editor-core";
import { onBeforeUnmount, onMounted, ref } from "vue";
import { editorType, useMonaco, watchEditorType } from "../../../composables/workspace/useMonaco";

// `caret` is an offset into `text`: where the click that opened this block landed (see caretOffsetInSource).
const { text, caret } = defineProps<{ text: string; caret: number }>();
const emit = defineEmits<{
    // Every keystroke. The surface holds this as the block's pending text and splices it into the document to
    // report the file's dirty state, without re-splitting the document underneath a live caret.
    change: [value: string];
    // Ctrl/Cmd+S from inside the block: the surface commits and saves the file, exactly as the toolbar would.
    save: [];
    // The caret has left, and in which direction: `up`/`down` move to the neighbouring block, `out` gives the
    // document back (Escape). Blur is not one of these; the surface watches for that itself.
    leave: [direction: "up" | "down" | "out"];
}>();

const { ensureMonaco, ensureLanguage } = useMonaco();
const host = ref<HTMLElement>();
let editor: Monaco.editor.IStandaloneCodeEditor | undefined;
let model: Monaco.editor.ITextModel | undefined;
let disposed = false;

/* The rendered block was as wide as the prose column and as tall as it needed to be; the editor has to be the
 * same or the document jumps when a block is clicked. Monaco reports the height its content wants, and this is
 * the whole of the layout: the host takes that height, and Monaco is laid out into it. */
const fit = (): void => {
    const view = editor;
    const box = host.value;
    if (view === undefined || box === undefined) {
        return;
    }
    const height = view.getContentHeight();
    box.style.height = `${height}px`;
    view.layout({ width: box.clientWidth, height });
};

onMounted(async () => {
    const monaco = await ensureMonaco();
    const lang = await ensureLanguage(monaco, `markdown`);
    if (disposed || host.value === undefined) {
        return; // The block was deactivated (or the file switched) while Monaco loaded.
    }
    model = monaco.editor.createModel(text, lang);
    model.updateOptions({ tabSize: 2, insertSpaces: true });
    const mono = getComputedStyle(document.documentElement).getPropertyValue(`--font-mono`).trim() || `monospace`;
    const view = monaco.editor.create(host.value, {
        model,
        automaticLayout: false, // `fit` owns the layout: the height is content-driven, not container-driven.
        // Everything a code surface has for navigating a FILE is noise around a paragraph: there is no line to
        // number, nothing far enough away to need a map, and no second column to fold.
        minimap: { enabled: false },
        lineNumbers: `off`,
        lineDecorationsWidth: 0,
        lineNumbersMinChars: 0,
        glyphMargin: false,
        folding: false,
        renderLineHighlight: `none`,
        overviewRulerLanes: 0,
        hideCursorInOverviewRuler: true,
        overviewRulerBorder: false,
        scrollbar: { vertical: `hidden`, horizontal: `hidden`, verticalScrollbarSize: 0, horizontalScrollbarSize: 0, alwaysConsumeMouseWheel: false },
        scrollBeyondLastLine: false,
        // Prose wraps; a paragraph that scrolled sideways would be unreadable in a column of text that doesn't.
        // `advanced` because the content height below has to account for the wrapped rows, not the logical ones.
        wordWrap: `on`,
        wrappingStrategy: `advanced`,
        fontFamily: mono,
        ...editorType(),
        padding: { top: 6, bottom: 6 },
        fixedOverflowWidgets: true,
        // A paragraph is not where anyone wants a completion popup; the file's words are not a dictionary.
        quickSuggestions: false,
        suggestOnTriggerCharacters: false,
        occurrencesHighlight: `off`,
        selectionHighlight: false,
        matchBrackets: `never`,
        renderWhitespace: `none`,
    });
    editor = view;

    view.onDidContentSizeChange(fit);
    fit();
    view.onDidChangeModelContent(() => emit(`change`, model?.getValue() ?? ``));

    view.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => emit(`save`));
    view.addCommand(monaco.KeyCode.Escape, () => emit(`leave`, `out`));

    /* Arrowing off the top or bottom EDGE belongs to the document, not to this block, so it is taken before
     * Monaco moves the caret. Everywhere else these are ordinary cursor moves, and stealing them would break
     * arrowing through a block that has more than one row in it.
     *
     * THE EDGE IS A VISUAL ROW, NOT A LOGICAL LINE, and the difference is the whole of this code. Prose wraps:
     * one source line of a paragraph is routinely three rows on screen, so "the caret is on line 1" is true for
     * all three of them. Testing that, the caret jumped out of the paragraph the first time the reader pressed
     * Up in the middle of it. Row identity is read off the caret's painted position instead (the editor is
     * content-sized and never scrolls, so this is exact), which is the same visual-vs-logical distinction VS
     * Code's own markdown editor draws, and it makes the check independent of how the text happens to wrap. */
    const rowTop = (at: Monaco.IPosition): number | undefined => view.getScrolledVisiblePosition(at)?.top;
    view.onKeyDown((event) => {
        const position = view.getPosition();
        if (position === null || model === undefined) {
            return;
        }
        const up = event.keyCode === monaco.KeyCode.UpArrow;
        const down = event.keyCode === monaco.KeyCode.DownArrow;
        if ((!up && !down) || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
            return;
        }
        const here = rowTop(position);
        const edge = up ? rowTop({ lineNumber: 1, column: 1 }) : rowTop(model.getPositionAt(model.getValueLength()));
        // No painted position to compare (a measurement mid-layout): fall back to the logical line, which is
        // right for every block that does not wrap and no worse than nothing for one that does.
        const atEdge =
            here === undefined || edge === undefined
                ? up
                    ? position.lineNumber === 1
                    : position.lineNumber === model.getLineCount()
                : here === edge;
        if (atEdge) {
            event.preventDefault();
            event.stopPropagation();
            emit(`leave`, up ? `up` : `down`);
        }
    });

    // The click that opened this block picked a spot in the paragraph; land there rather than at one end of it.
    view.setPosition(model.getPositionAt(Math.max(0, Math.min(caret, text.length))));
    view.focus();
    view.revealPositionInCenterIfOutsideViewport(view.getPosition() ?? { lineNumber: 1, column: 1 });
});

// The app's text-size control reaches the open block too, so a paragraph being edited is the size of the prose
// around it rather than the size it was when it opened.
watchEditorType((type) => {
    editor?.updateOptions(type);
    fit();
});

defineExpose({ focus: (): void => editor?.focus() });

onBeforeUnmount(() => {
    disposed = true;
    model?.dispose();
    editor?.dispose();
});
</script>

<template>
    <!-- The card VS Code's hybrid editor draws around its active block, for the same reason: the reader has to
         be able to see at a glance which paragraph is theirs to type in. -->
    <div class="md-block-editor my-1 rounded-md bg-overlay/60 ring-1 ring-line">
        <div ref="host" class="w-full"></div>
    </div>
</template>
