<script lang="ts">
import type * as Monaco from "monaco-editor-core";
// View state (scroll + cursor/selection + folding) per file, shared across the read-only and editable
// instances so toggling Edit/Preview and switching tabs keeps the position — module scope, like the old
// FileCode's scrollMemory, but Monaco's own richer view state.
const viewStates = new Map<string, Monaco.editor.ICodeEditorViewState>();
</script>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { normalizationEdits } from "../../../composables/workspace/normalizeOnSave";
import { useEditorSelection } from "../../../composables/workspace/useEditorSelection";
import { useMonaco } from "../../../composables/workspace/useMonaco";
import type { LineJump } from "../workspaceTabs";

/* The workspace code surface — a single Monaco editor for BOTH the read-only preview and (with `editable`) the
 * editor, so the two are the same rendering with a VSCode minimap. `lang === undefined` (unknown extension or a
 * file over the highlight cap) opens as plaintext (no tokenizer). Colored by Shiki via @shikijs/monaco. */

const { code, lang, scrollToLine, editable, path } = defineProps<{
    code: string;
    lang?: string;
    scrollToLine?: LineJump;
    editable?: boolean;
    path?: string;
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

// Land a content-search jump: cursor on the line (keyboard nav continues from the hit), centered scroll, and a
// one-shot highlight of the line (reuses the ws-line-flash keyframes).
const jumpTo = (line: number): void => {
    if (monaco === undefined || editor.value === undefined) {
        return;
    }
    editor.value.setPosition({ lineNumber: line, column: 1 });
    editor.value.revealLineInCenter(line);
    const marks = editor.value.createDecorationsCollection([
        { range: new monaco.Range(line, 1, line, 1), options: { isWholeLine: true, className: `ws-line-flash` } },
    ]);
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => marks.clear(), 1500);
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
// The toolbar Save button (FileViewer) saves through this too, so both triggers normalize identically.
defineExpose({ save: doSave });

onMounted(async () => {
    const m = await ensureMonaco();
    await ensureLanguage(m, lang);
    if (disposed || host.value === undefined) {
        return; // unmounted (fast file-switch) while Monaco/grammar loaded
    }
    monaco = m;
    model = m.editor.createModel(code, lang);
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
        // The minimap slider is the vertical scroll affordance — a scrollbar beside it is redundant
        // (wheel/keyboard/minimap-drag still scroll). Horizontal stays for long lines. Size 0 too:
        // `hidden` alone still reserves the 14px strip in the layout.
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
                startLine: selection.startLineNumber,
                endLine: selection.endLineNumber,
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
        if (!editable && model !== undefined && model.getValue() !== next) {
            model.setValue(next);
        }
    },
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
