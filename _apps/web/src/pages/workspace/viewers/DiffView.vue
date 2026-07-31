<script setup lang="ts">
import { useDevice } from "@intentic-app/ui";
import type * as Monaco from "monaco-editor-core";
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { useLayout } from "../../../composables/useLayout";
import { stripComments } from "../../../composables/workspace/codeComments";
import { useMonaco } from "../../../composables/workspace/useMonaco";
import { langFromShebang, resolveFile } from "../fileType";

/* Diff of one file across a snapshot (before = parent, after = the snapshot) on Monaco's diff editor — the
 * same engine VSCode uses, so it brings its own minimap, change overview ruler, and diff computation. Side-by-side
 * with a minimap per pane on desktop; inline/unified on mobile, where two panes can't fit (chunk navigation moves
 * to prev/next buttons there). Read-only; an absent side (added/deleted file) is an empty pane. Uncontrolled —
 * the parent remounts per file via :key.
 *
 * Comments are stripped from both sides unless the reader asks for them (useLayout.showComments, off by default):
 * the diff is then computed on code alone, so comment churn stops registering as change at all. Both reading
 * settings are the reader's, held in useLayout and driven by DiffToolbar, which every host renders above this. */

const { before, after, path } = defineProps<{ before?: string; after?: string; path: string }>();

const { mobile } = useDevice();
const { ensureMonaco, ensureLanguage } = useMonaco();
const { showComments, toggleShowComments, diffLayout } = useLayout();
// The stored preference is a desktop one: two panes cannot fit a phone, so mobile is always inline regardless.
const split = computed(() => !mobile.value && diffLayout.value === `split`);

const host = ref<HTMLElement>();
const diff = shallowRef<Monaco.editor.IStandaloneDiffEditor>();
let original: Monaco.editor.ITextModel | undefined;
let modified: Monaco.editor.ITextModel | undefined;
let lang: string | undefined;
let disposed = false;
// The file changed, but not once the comments come out — an empty diff has to say why it is empty.
const commentsOnly = ref(false);

const step = (forward: boolean): void => diff.value?.goToDiff(forward ? `next` : `previous`);

// One side as its pane should show it. Stripping shortens the model, so the gutter has to render the source line
// each kept line came from — Monaco's own numbering would be off by every comment above it.
const side = async (text: string): Promise<{ text: string; lineNumbers: Monaco.editor.LineNumbersType }> => {
    const stripped = showComments.value ? undefined : await stripComments(text, lang);
    if (stripped === undefined) {
        return { text, lineNumbers: `on` };
    }
    return { text: stripped.text, lineNumbers: (line) => String(stripped.lines[line - 1] ?? ``) };
};

// Load both sides into the panes. Also the toggle's whole effect: same editor, same file, comments in or out.
const render = async (editor: Monaco.editor.IStandaloneDiffEditor): Promise<void> => {
    const [left, right] = await Promise.all([side(before ?? ``), side(after ?? ``)]);
    if (disposed) {
        return; // unmounted (fast file-switch) while the grammar tokenized
    }
    original?.setValue(left.text);
    modified?.setValue(right.text);
    editor.getOriginalEditor().updateOptions({ lineNumbers: left.lineNumbers });
    editor.getModifiedEditor().updateOptions({ lineNumbers: right.lineNumbers });
    commentsOnly.value = left.text === right.text && (before ?? ``) !== (after ?? ``);
};

onMounted(async () => {
    const m = await ensureMonaco();
    // Filename first (like resolveFile); for an extensionless script fall back to the shebang in either side's
    // bytes (both panes carry the same file, so whichever is present agrees), matching VSCode.
    lang = resolveFile(path, undefined).lang ?? langFromShebang(after ?? before ?? ``);
    await ensureLanguage(m, lang);
    if (disposed || host.value === undefined) {
        return; // unmounted (fast file-switch) while Monaco/grammar loaded
    }
    const mono = getComputedStyle(document.documentElement).getPropertyValue(`--font-mono`).trim() || `monospace`;
    const editor = m.editor.createDiffEditor(host.value, {
        readOnly: true,
        originalEditable: false,
        automaticLayout: true,
        renderSideBySide: split.value,
        minimap: { enabled: true },
        // Minimap slider + diff overview ruler cover vertical navigation; the per-pane scrollbars are
        // redundant next to them. Horizontal stays for long lines. Size 0 too: `hidden` alone still
        // reserves the 14px strip in the layout.
        scrollbar: { vertical: `hidden`, verticalScrollbarSize: 0 },
        // Collapse runs of unchanged lines to a few lines of context, like the old collapseUnchanged.
        hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 3, revealLineCount: 20 },
        scrollBeyondLastLine: false,
        renderMarginRevertIcon: false,
        fontFamily: mono,
        fontSize: 13,
        lineHeight: 20,
    });
    diff.value = editor;
    // Empty models first: `render` owns what goes in them, so the toggle and the first paint take one path.
    original = m.editor.createModel(``, lang);
    modified = m.editor.createModel(``, lang);
    editor.setModel({ original, modified });
    await render(editor);

    // VSCode's diff-navigation keys, on the focused (modified) pane.
    const modifiedEditor = editor.getModifiedEditor();
    modifiedEditor.addCommand(m.KeyCode.F7, () => editor.goToDiff(`next`));
    modifiedEditor.addCommand(m.KeyMod.Shift | m.KeyCode.F7, () => editor.goToDiff(`previous`));
});

// Crossing the breakpoint (rotation, split-screen) or flipping the toolbar's toggle swaps side-by-side ↔
// unified in place — no rebuild.
watch(split, (on) => diff.value?.updateOptions({ renderSideBySide: on }));

watch(showComments, async () => {
    if (diff.value !== undefined) {
        await render(diff.value);
    }
});

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
        <!-- Hiding comments can leave nothing at all to look at. Saying so — and offering the one click that
             brings the change back — beats a blank diff the reader has to explain to themselves. -->
        <div v-if="commentsOnly" class="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center px-9">
            <button
                type="button"
                class="pointer-events-auto flex items-center gap-1.5 rounded-full border border-line bg-card/95 px-3 py-1 text-2xs text-muted shadow-sm backdrop-blur transition-colors hover:text-content"
                @click="toggleShowComments()"
            >
                <Icon name="eye-slash" class="text-2xs" />
                Only comments changed — show them
            </button>
        </div>
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
