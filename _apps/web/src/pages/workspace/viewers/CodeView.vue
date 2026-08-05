<script lang="ts">
import type * as Monaco from "monaco-editor-core";
// View state (scroll + cursor/selection + folding) per file, shared across the read-only and editable
// instances so toggling Edit/Preview and switching tabs keeps the position — module scope, like the old
// FileCode's scrollMemory, but Monaco's own richer view state.
const viewStates = new Map<string, Monaco.editor.ICodeEditorViewState>();
</script>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { modelLineOf, stripComments } from "../../../composables/workspace/codeComments";
import { normalizationEdits } from "../../../composables/workspace/normalizeOnSave";
import { useEditorSelection } from "../../../composables/workspace/useEditorSelection";
import { useMonaco } from "../../../composables/workspace/useMonaco";
import type { LineJump } from "../workspaceTabs";

/* The workspace code surface — a single Monaco editor for BOTH the read-only preview and (with `editable`) the
 * editor, so the two are the same rendering with a VSCode minimap. `lang === undefined` (unknown extension or a
 * file over the highlight cap) opens as plaintext (no tokenizer). Colored by Shiki via @shikijs/monaco.
 *
 * With `hideComments` the reader gets the code alone: the same strip the diff surface uses (codeComments.ts), so
 * a file reads the same whether it is being reviewed or read. The comments are REMOVED rather than folded — a
 * folded comment still spends a line saying it is there — which shortens the model, so the file's own numbering
 * is carried alongside and used for everything the reader or the app can see: the gutter, a search jump, the
 * selection the chat's context chip reads. Never applied while editing: a buffer without the comments would
 * SAVE the file without them. */

const { code, lang, scrollToLine, editable, path, hideComments } = defineProps<{
    code: string;
    lang?: string;
    scrollToLine?: LineJump;
    editable?: boolean;
    path?: string;
    hideComments?: boolean;
}>();
const emit = defineEmits<{ change: [value: string]; save: [value: string] }>();

const { ensureMonaco, ensureLanguage } = useMonaco();
const editorSelection = useEditorSelection();

const host = ref<HTMLElement>();
const editor = shallowRef<Monaco.editor.IStandaloneCodeEditor>();
let monaco: typeof Monaco | undefined;
let model: Monaco.editor.ITextModel | undefined;
let flashTimer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
// The file's line each model line came from, while the comments are out; undefined when the model IS the file.
let sourceLines: number[] | undefined;

// The file's line `line` of the model holds — identity when nothing was stripped.
const fileLine = (line: number): number => sourceLines?.[line - 1] ?? line;

// What the model should hold, and the mapping back to the file it came from. `undefined` lines means the two are
// the same text, which is the answer for every editable surface and for a file the stripper declines: no grammar
// for it (unknown extension, plaintext), a budget it blew, or nothing but comments in it — a file with no code to
// isolate is shown whole rather than as an empty pane the reader has to explain to themselves.
const display = async (text: string): Promise<{ text: string; lines?: number[] }> => {
    if (editable === true || hideComments !== true) {
        return { text };
    }
    const stripped = await stripComments(text, lang);
    if (stripped === undefined || stripped.text.trim() === ``) {
        return { text };
    }
    return { text: stripped.text, lines: stripped.lines };
};

// Land a content-search jump: cursor on the line (keyboard nav continues from the hit), centered scroll, and a
// one-shot highlight of the line (reuses the ws-line-flash keyframes). `line` is the FILE's, so with the comments
// out it lands on the line that kept it — or on the code the removed comment introduces.
const jumpTo = (line: number): void => {
    if (monaco === undefined || editor.value === undefined) {
        return;
    }
    const target = sourceLines === undefined ? line : modelLineOf(sourceLines, line);
    editor.value.setPosition({ lineNumber: target, column: 1 });
    editor.value.revealLineInCenter(target);
    const marks = editor.value.createDecorationsCollection([
        { range: new monaco.Range(target, 1, target, 1), options: { isWholeLine: true, className: `ws-line-flash` } },
    ]);
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => marks.clear(), 1500);
};

let rendered = 0;
/* Put `text` in the model the way the reader wants it, keeping their place. Both callers can be in flight at once
 * (an external write landing while the toggle's tokenizer runs), so the later one wins outright — a stale pair
 * would leave the gutter numbering a text it no longer holds. setValue lands the reader back at line 1 otherwise,
 * and losing your place mid-file is worse than the comments you wanted gone: the top line is remembered as the
 * FILE's, which is the one thing both views agree on.
 *
 * Scrolled to exactly, not revealed: every reveal* keeps a margin of context above the line, so toggling twice
 * walks the reader backwards through the file a screenful at a time. */
const render = async (text: string): Promise<void> => {
    const view = editor.value;
    if (model === undefined || view === undefined) {
        return;
    }
    const id = ++rendered;
    const top = view.getVisibleRanges()[0]?.startLineNumber;
    const anchor = top === undefined ? undefined : fileLine(top);
    const next = await display(text);
    if (disposed || id !== rendered || model.getValue() === next.text) {
        return;
    }
    sourceLines = next.lines;
    model.setValue(next.text);
    if (anchor !== undefined) {
        view.setScrollTop(view.getTopForLineNumber(next.lines === undefined ? anchor : modelLineOf(next.lines, anchor)));
    }
};

// Save = normalize, then emit the normalized text. Normalization (LF EOLs, no trailing whitespace — kept for
// markdown hard breaks — one final newline) lands as model edits via pushEditOperations, so the cursor stays put
// and undo works; the emitted value is then exactly what the editor shows AND what lands on disk, keeping the
// buffer/baseline/disk one shape (the save echo reconciles as a no-op). The point is the agent: its exact-string
// edits fail on invisible whitespace drift, so every file a user saves is already in the shape the agent expects.
const doSave = (): void => {
    if (!editable || monaco === undefined || model === undefined) {
        return;
    }
    const m = monaco;
    const target = model;
    if (target.getEOL() !== `\n`) {
        target.setEOL(m.editor.EndOfLineSequence.LF);
    }
    const lines = Array.from({ length: target.getLineCount() }, (_, index) => target.getLineContent(index + 1));
    const edits = normalizationEdits(lines, lang !== `markdown`);
    if (edits.length > 0) {
        target.pushEditOperations(
            [],
            edits.map((edit) => ({ range: new m.Range(edit.startLine, edit.startColumn, edit.endLine, edit.endColumn), text: edit.text })),
            () => null,
        );
    }
    emit(`save`, target.getValue());
};
/* Append text at the end of the model, for the windowed viewer loading the next slice of a huge file. An edit
 * rather than a new `code` prop: setValue() rebuilds the whole model and throws away the view state, so paging
 * through a log would yank the reader back to wherever the new scroll landed. This keeps the position, and
 * Monaco only tokenizes and paints what the append touched. */
const appendText = (text: string): void => {
    if (monaco === undefined || model === undefined) {
        return;
    }
    const end = model.getFullModelRange().getEndPosition();
    model.applyEdits([{ range: new monaco.Range(end.lineNumber, end.column, end.lineNumber, end.column), text }]);
};

// Scroll the last line into view — how a tail-follow lands its newly appended bytes.
const revealEnd = (): void => {
    if (model !== undefined) {
        editor.value?.revealLine(model.getLineCount());
    }
};

// The toolbar Save button (FileViewer) saves through this too, so both triggers normalize identically.
defineExpose({ save: doSave, append: appendText, revealEnd });

onMounted(async () => {
    const m = await ensureMonaco();
    await ensureLanguage(m, lang);
    if (disposed || host.value === undefined) {
        return; // unmounted (fast file-switch) while Monaco/grammar loaded
    }
    monaco = m;
    // Stripped before the model exists rather than after, so a file opened with the comments off never flashes
    // them first. The grammar it tokenizes with is the one ensureLanguage just loaded.
    const first = await display(code);
    if (disposed || host.value === undefined) {
        return; // unmounted (fast file-switch) while the stripper tokenized
    }
    sourceLines = first.lines;
    model = m.editor.createModel(first.text, lang);
    if (editable) {
        model.updateOptions({ tabSize: 2, insertSpaces: true });
    }
    const mono = getComputedStyle(document.documentElement).getPropertyValue(`--font-mono`).trim() || `monospace`;
    const view = m.editor.create(host.value, {
        model,
        readOnly: !editable,
        domReadOnly: !editable,
        automaticLayout: true,
        minimap: { enabled: true },
        // Wrap, so a long line is READ rather than scrolled to. Continuation rows carry no gutter number,
        // which is what marks them as a wrap. `bounded` rather than `on`: wrap at the viewport when the pane
        // is narrow, but on a wide one stop just past this repo's own 150-column format width — so formatted
        // source keeps its intended shape and only genuine overflow (prose, logs, generated files) folds.
        wordWrap: `bounded`,
        wordWrapColumn: 160,
        // The FILE's numbering, always — with the comments out the model is short by every line removed, and a
        // gutter counting its own lines would print numbers that match nothing the reader can act on (a jump, a
        // ref they paste into chat, the same file in the diff). Identity while nothing is stripped.
        lineNumbers: (line) => String(fileLine(line)),
        // The minimap slider is the vertical scroll affordance — a scrollbar beside it is redundant
        // (wheel/keyboard/minimap-drag still scroll). Size 0 too: `hidden` alone still reserves the 14px
        // strip in the layout. Horizontal only ever appears for what wrapping can't fold (a long token).
        scrollbar: { vertical: `hidden`, verticalScrollbarSize: 0 },
        overviewRulerLanes: 0,
        hideCursorInOverviewRuler: true,
        scrollBeyondLastLine: false,
        fontFamily: mono,
        fontSize: 13,
        lineHeight: 20,
        padding: { top: 12, bottom: 12 },
        smoothScrolling: true,
        fixedOverflowWidgets: true,
    });
    editor.value = view;

    if (editable) {
        model.onDidChangeContent(() => emit(`change`, model?.getValue() ?? ``));
        view.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, doSave);
        // Monaco's command binds the key, but Ctrl/Cmd+S still reaches the browser's Save-page dialog — stop it.
        view.onKeyDown((event) => {
            if ((event.ctrlKey || event.metaKey) && event.keyCode === m.KeyCode.KeyS) {
                event.preventDefault();
            }
        });
    }

    // Publish the live selection for the chat composer's editor-context chip (opt-in there, so reporting is
    // free). Collapsed cursor ⇒ no selection; the chip then offers the whole file instead.
    if (path !== undefined) {
        const filePath = path;
        view.onDidChangeCursorSelection((event) => {
            const selection = event.selection;
            if (selection.isEmpty() || model === undefined) {
                editorSelection.clear(filePath);
                return;
            }
            editorSelection.report({
                path: filePath,
                // The file's lines, not the view's: the agent reads the file from disk, comments and all.
                startLine: fileLine(selection.startLineNumber),
                endLine: fileLine(selection.endLineNumber),
                text: model.getValueInRange(selection),
            });
        });
    }

    // A content-search jump wins; otherwise restore the remembered position (first open of a file has none).
    if (scrollToLine !== undefined) {
        jumpTo(scrollToLine.line);
        return;
    }
    const saved = path !== undefined ? viewStates.get(path) : undefined;
    if (saved !== undefined) {
        view.restoreViewState(saved);
    }
});

// Later jumps land on the LIVE editor — clicking hits while the file is already open. Each jump is a fresh
// object (seq), so even the same line re-reveals; the mount path above covers jumps that open the file.
watch(
    () => scrollToLine,
    (next) => {
        if (next !== undefined) {
            jumpTo(next.line);
        }
    },
);

// Read-only mirrors the incoming prop (post-save refetch, external change); editable is uncontrolled and
// remounted per file via :key, so it never clobbers the live text from the textarea.
watch(
    () => code,
    (next) => {
        if (!editable) {
            void render(next);
        }
    },
);

// Comments in or out, in place: same editor, same file, same scroll position — no remount, and the setting is
// the reader's (useLayout), so it holds as they walk from file to file.
watch(
    () => hideComments,
    () => void render(code),
);

onBeforeUnmount(() => {
    disposed = true;
    clearTimeout(flashTimer);
    if (path !== undefined) {
        editorSelection.clear(path);
    }
    if (path !== undefined && editor.value !== undefined) {
        const state = editor.value.saveViewState();
        if (state !== null) {
            viewStates.set(path, state);
        }
    }
    model?.dispose();
    editor.value?.dispose();
});
</script>

<template>
    <div ref="host" class="h-full w-full bg-canvas"></div>
</template>
