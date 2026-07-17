<script setup lang="ts">
import { useDevice } from "@intentic-app/ui";
import type * as Monaco from "monaco-editor-core";
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { useMonaco } from "../../../composables/workspace/useMonaco";
import { resolveFile } from "../fileType";

/* Diff of one file across a snapshot (before = parent, after = the snapshot) on Monaco's diff editor — the
 * same engine VSCode uses, so it brings its own minimap, change overview ruler, and diff computation. Side-by-side
 * with a minimap per pane on desktop; inline/unified on mobile, where two panes can't fit (chunk navigation moves
 * to prev/next buttons there). Read-only; an absent side (added/deleted file) is an empty pane. Uncontrolled —
 * the parent remounts per file via :key. */

const { before, after, path } = defineProps<{ before?: string; after?: string; path: string }>();

const { mobile } = useDevice();
const { ensureMonaco, ensureLanguage } = useMonaco();

const host = ref<HTMLElement>();
const diff = shallowRef<Monaco.editor.IStandaloneDiffEditor>();
let original: Monaco.editor.ITextModel | undefined;
let modified: Monaco.editor.ITextModel | undefined;
let disposed = false;

const step = (forward: boolean): void => diff.value?.goToDiff(forward ? `next` : `previous`);

onMounted(async () => {
    const m = await ensureMonaco();
    const lang = resolveFile(path, undefined).lang;
    await ensureLanguage(m, lang);
    if (disposed || host.value === undefined) {
        return; // unmounted (fast file-switch) while Monaco/grammar loaded
    }
    const mono = getComputedStyle(document.documentElement).getPropertyValue(`--font-mono`).trim() || `monospace`;
    const editor = m.editor.createDiffEditor(host.value, {
        readOnly: true,
        originalEditable: false,
        automaticLayout: true,
        renderSideBySide: !mobile.value,
        minimap: { enabled: true },
        // Collapse runs of unchanged lines to a few lines of context, like the old collapseUnchanged.
        hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 3, revealLineCount: 20 },
        scrollBeyondLastLine: false,
        renderMarginRevertIcon: false,
        fontFamily: mono,
        fontSize: 13,
        lineHeight: 20,
    });
    diff.value = editor;
    original = m.editor.createModel(before ?? ``, lang);
    modified = m.editor.createModel(after ?? ``, lang);
    editor.setModel({ original, modified });

    // VSCode's diff-navigation keys, on the focused (modified) pane.
    const modifiedEditor = editor.getModifiedEditor();
    modifiedEditor.addCommand(m.KeyCode.F7, () => editor.goToDiff(`next`));
    modifiedEditor.addCommand(m.KeyMod.Shift | m.KeyCode.F7, () => editor.goToDiff(`previous`));
});

// Crossing the breakpoint (rotation, split-screen) swaps side-by-side ↔ unified in place — no rebuild.
watch(mobile, (isMobile) => diff.value?.updateOptions({ renderSideBySide: !isMobile }));

onBeforeUnmount(() => {
    disposed = true;
    diff.value?.dispose();
    original?.dispose();
    modified?.dispose();
});
</script>

<template>
    <div class="relative flex h-full min-h-0">
        <div ref="host" class="h-full min-w-0 flex-1 overflow-hidden bg-canvas"></div>
        <!-- Touch chunk navigation (side-by-side collapses to unified on mobile). -->
        <div v-if="mobile" class="absolute bottom-4 right-4 z-10 flex gap-2">
            <button
                type="button"
                class="flex h-11 w-11 items-center justify-center rounded-full border border-line bg-card/90 text-muted shadow-lg active:bg-overlay"
                aria-label="Previous change"
                @click="step(false)"
            >
                <Icon name="chevron-up" class="text-base" />
            </button>
            <button
                type="button"
                class="flex h-11 w-11 items-center justify-center rounded-full border border-line bg-card/90 text-muted shadow-lg active:bg-overlay"
                aria-label="Next change"
                @click="step(true)"
            >
                <Icon name="chevron-down" class="text-base" />
            </button>
        </div>
    </div>
</template>
