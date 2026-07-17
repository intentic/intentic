<script lang="ts">
import type * as Monaco from "monaco-editor-core";
// View state (scroll + cursor/selection + folding) per file, shared across the read-only and editable
// instances so toggling Edit/Preview and switching tabs keeps the position — module scope, like the old
// FileCode's scrollMemory, but Monaco's own richer view state.
const viewStates = new Map<string, Monaco.editor.ICodeEditorViewState>();
</script>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { useMonaco } from "../../../composables/workspace/useMonaco";

/* The workspace code surface — a single Monaco editor for BOTH the read-only preview and (with `editable`) the
 * editor, so the two are the same rendering with a VSCode minimap. `lang === undefined` (unknown extension or a
 * file over the highlight cap) opens as plaintext (no tokenizer). Colored by Shiki via @shikijs/monaco. */

const { code, lang, scrollToLine, editable, path } = defineProps<{
    code: string;
    lang?: string;
    scrollToLine?: number;
    editable?: boolean;
    path?: string;
}>();
const emit = defineEmits<{ change: [value: string]; save: [value: string] }>();

const { ensureMonaco, ensureLanguage } = useMonaco();

const host = ref<HTMLElement>();
const editor = shallowRef<Monaco.editor.IStandaloneCodeEditor>();
let monaco: typeof Monaco | undefined;
let model: Monaco.editor.ITextModel | undefined;
let flashTimer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;

// One-shot highlight of the line a content-search match landed on (reuses the ws-line-flash keyframes).
const flash = (line: number): void => {
    if (monaco === undefined || editor.value === undefined) {
        return;
    }
    const marks = editor.value.createDecorationsCollection([
        { range: new monaco.Range(line, 1, line, 1), options: { isWholeLine: true, className: `ws-line-flash` } },
    ]);
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => marks.clear(), 1500);
};

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
        view.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, () => emit(`save`, model?.getValue() ?? ``));
        // Monaco's command binds the key, but Ctrl/Cmd+S still reaches the browser's Save-page dialog — stop it.
        view.onKeyDown((event) => {
            if ((event.ctrlKey || event.metaKey) && event.keyCode === m.KeyCode.KeyS) {
                event.preventDefault();
            }
        });
    }

    // A content-search jump wins; otherwise restore the remembered position (first open of a file has none).
    if (scrollToLine !== undefined) {
        view.revealLineInCenter(scrollToLine);
        flash(scrollToLine);
        return;
    }
    const saved = path !== undefined ? viewStates.get(path) : undefined;
    if (saved !== undefined) {
        view.restoreViewState(saved);
    }
});

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
