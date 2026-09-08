<script lang="ts">
import type * as Monaco from "monaco-editor-core";
// View state (scroll, cursor, folding) per file, module-scoped so toggling Edit/Preview keeps position.
const viewStates = new Map<string, Monaco.editor.ICodeEditorViewState>();
</script>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { modelLineOf } from "@intentic/code-read";
import { requestCodeAnalysis } from "../health/codeAnalysisClient";
import { normalizationEdits } from "../files/normalizeOnSave";
import { useEditorSelection } from "../files/useEditorSelection";
import { editorType, useMonaco, watchEditorType } from "../files/useMonaco";
import type { LineJump } from "../tabs/workspaceTabs";

// Single Monaco editor for both read-only preview and (with `editable`) editing, coloured by Shiki; no lang or
// over the highlight cap opens as plaintext. `hideComments` removes (not folds) comments, keeping the file's own
// line numbers for the gutter/jumps/selection; never applied while editing, or a save would drop them from disk.

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
// Grammar Monaco loaded; undefined on a failed chunk, so editor and stripper share one plaintext fallback.
let modelLang: string | undefined;
let flashTimer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
// File line each model line came from, while comments are out; undefined when model equals file.
let sourceLines: number[] | undefined;

// The file's line `line` of the model holds: identity when nothing was stripped.
const fileLine = (line: number): number => sourceLines?.[line - 1] ?? line;

// What the model should hold, plus the mapping back to its file lines. `undefined` lines means unchanged text:
// every editable surface, or a file the stripper declines (no grammar, over budget, all-comment).
const display = async (text: string): Promise<{ text: string; lines?: number[] }> => {
    if (editable === true || hideComments !== true) {
        return { text };
    }
    const analysis = await requestCodeAnalysis(text, modelLang);
    if (analysis === undefined || analysis.code.text.trim() === ``) {
        return { text };
    }
    return analysis.code;
};

// Lands a content-search jump: cursor + centered scroll + a 1.5s highlight. `line` is the file's, so with
// comments stripped it lands on whatever code took that line's place.
const jumpTo = (line: number): void => {
    if (monaco === undefined || editor.value === undefined) {
        return;
    }
    const view = editor.value;
    const target = sourceLines === undefined ? line : modelLineOf(sourceLines, line);
    view.setPosition({ lineNumber: target, column: 1 });
    view.revealLineInCenter(target);
    // Re-asserts the reveal until it lands: revealLineInCenter can silently fail against a pane Monaco hasn't
    // measured yet. Retries every frame while off-screen, bounded to about half a second.
    let attempts = 0;
    let lastTop = view.getScrollTop();
    const onScreen = (): boolean => view.getVisibleRanges().some((range) => range.startLineNumber <= target && target <= range.endLineNumber);
    const settle = (): void => {
        if (disposed || editor.value !== view || onScreen() || ++attempts > 30) {
            return;
        }
        const top = view.getScrollTop();
        // Only re-asks while scroll is stuck; re-revealing into a live smooth-scroll animation would make it crawl.
        if (top === lastTop) {
            view.revealLineInCenter(target);
        }
        lastTop = top;
        requestAnimationFrame(settle);
    };
    requestAnimationFrame(settle);
    const marks = view.createDecorationsCollection([
        { range: new monaco.Range(target, 1, target, 1), options: { isWholeLine: true, className: `ws-line-flash` } },
    ]);
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => marks.clear(), 1500);
};

let rendered = 0;
// Sets `text` in the model, keeping the reader's place; the later of two concurrent calls wins, since a stale
// one mislabels the gutter. Scrolled to the anchored file line exactly, or toggling twice would drift the view.
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

// Save normalizes first (LF EOLs, no trailing whitespace but markdown hard breaks, one final newline) via
// pushEditOperations, so cursor/undo survive and disk matches exactly what the agent's exact-string edits expect.
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
// Appends text for the windowed big-file viewer's next slice. An edit, not a new `code` prop: setValue() would
// rebuild the model and lose the view state (and scroll position); this only tokenizes/paints what changed.
const appendText = (text: string): void => {
    if (monaco === undefined || model === undefined) {
        return;
    }
    const end = model.getFullModelRange().getEndPosition();
    model.applyEdits([{ range: new monaco.Range(end.lineNumber, end.column, end.lineNumber, end.column), text }]);
};

// Scroll the last line into view: how a tail-follow lands its newly appended bytes.
const revealEnd = (): void => {
    if (model !== undefined) {
        editor.value?.revealLine(model.getLineCount());
    }
};

// The toolbar Save button (FileViewer) saves through this too, so both triggers normalize identically.
defineExpose({ save: doSave, append: appendText, revealEnd });

onMounted(async () => {
    const m = await ensureMonaco();
    modelLang = await ensureLanguage(m, lang);
    if (disposed || host.value === undefined) {
        return; // unmounted (fast file-switch) while Monaco/grammar loaded
    }
    monaco = m;
    // Stripped before the model exists, so comments-off never flashes them first.
    const first = await display(code);
    if (disposed || host.value === undefined) {
        return; // unmounted (fast file-switch) while the stripper tokenized
    }
    sourceLines = first.lines;
    model = m.editor.createModel(first.text, modelLang);
    if (editable) {
        model.updateOptions({ tabSize: 2, insertSpaces: true });
    }
    const mono = getComputedStyle(document.documentElement).getPropertyValue(`--font-mono`).trim() || `monospace`;
    const view = m.editor.create(host.value, {
        model,
        readOnly: !editable,
        domReadOnly: !editable,
        automaticLayout: true,
        // Minimap slider is the only position indicator once the scrollbar is off; shown always instead of on hover.
        minimap: { enabled: true, showSlider: `always` },
        // Wraps a long line to be read, not scrolled to; continuation rows carry no gutter number. `bounded` wraps at
        // the viewport when narrow, else past this repo's 150-column width, so only real overflow folds.
        wordWrap: `bounded`,
        wordWrapColumn: 160,
        // Always the file's own numbering: with comments stripped, the model's own line count wouldn't match anything
        // the reader can act on (a jump, a chat reference, the diff). Identity when nothing is stripped.
        lineNumbers: (line) => String(fileLine(line)),
        // Vertical scrollbar hidden: the minimap slider is already the scroll affordance (wheel/keyboard/drag still
        // work). Size 0 too, since `hidden` alone still reserves its 14px strip.
        scrollbar: { vertical: `hidden`, verticalScrollbarSize: 0 },
        overviewRulerLanes: 0,
        hideCursorInOverviewRuler: true,
        scrollBeyondLastLine: false,
        fontFamily: mono,
        ...editorType(),
        padding: { top: 12, bottom: 12 },
        smoothScrolling: true,
        fixedOverflowWidgets: true,
    });
    editor.value = view;

    if (editable) {
        model.onDidChangeContent(() => emit(`change`, model?.getValue() ?? ``));
        view.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, doSave);
        // Monaco's command binds the key, but Ctrl/Cmd+S still reaches the browser's Save-page dialog: stop it.
        view.onKeyDown((event) => {
            if ((event.ctrlKey || event.metaKey) && event.keyCode === m.KeyCode.KeyS) {
                event.preventDefault();
            }
        });
    }

    // Publishes the live selection for the chat's editor-context chip. A collapsed cursor clears it, and the chip
    // falls back to the whole file.
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

    // A content-search jump wins over the remembered position (first open has none); jumpTo re-asserts the reveal
    // until the freshly created pane is measured.
    if (scrollToLine !== undefined) {
        jumpTo(scrollToLine.line);
        return;
    }
    const saved = path !== undefined ? viewStates.get(path) : undefined;
    if (saved !== undefined) {
        view.restoreViewState(saved);
    }
});

// Later jumps land on the live editor, once the file is already open (the mount path above covers opening
// jumps). A fresh object (seq) re-reveals even the same line.
watch(
    () => scrollToLine,
    (next) => {
        if (next !== undefined) {
            jumpTo(next.line);
        }
    },
);

// Read-only mirrors the incoming prop (refetch, external change); editable is uncontrolled and remounted per
// file via :key, so this never clobbers live text.
watch(
    () => code,
    (next) => {
        if (!editable) {
            void render(next);
        }
    },
);

// Toggles comments in place, no remount; the setting persists (useLayout) as the reader moves between files.
watch(
    () => hideComments,
    () => void render(code),
);

// Same for text size: the open file re-types live instead of waiting to be reopened.
watchEditorType((type) => editor.value?.updateOptions(type));

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
