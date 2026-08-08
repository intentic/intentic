<script setup lang="ts">
import { useDevice } from "@intentic/ui";
import type * as Monaco from "monaco-editor-core";
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { useLayout } from "../../../composables/useLayout";
import { stripComments } from "../../../composables/workspace/codeComments";
import { lineStat, type LineStat } from "../../../composables/workspace/codeStat";
import { firstChangeBeyondImports, importLines } from "../../../composables/workspace/codeImports";
import { editorType, useMonaco, watchEditorType } from "../../../composables/workspace/useMonaco";
import { highlightLangFor } from "../fileType";

/* Diff of one file across a snapshot (before = parent, after = the snapshot) on Monaco's diff editor — the
 * same engine VSCode uses, so it brings its own minimap, change overview ruler, and diff computation. Side-by-side
 * with a minimap per pane on desktop; inline/unified on mobile, where two panes can't fit (chunk navigation moves
 * to prev/next buttons there). Read-only; an absent side (added/deleted file) is an empty pane. Uncontrolled —
 * the parent remounts per file via :key.
 *
 * Comments are stripped from both sides unless the reader asks for them (useLayout.showComments, off by default):
 * the diff is then computed on code alone, so comment churn stops registering as change at all. Both reading
 * settings are the reader's, held in useLayout and driven by DiffToolbar, which every host renders above this.
 * A third — where the diff OPENS (useLayout.skipImports) — is set in Settings rather than up there: it decides
 * where this lands the reader on the way in, so a control over the code would look like it did nothing. */

const { before, after, path } = defineProps<{ before?: string; after?: string; path: string }>();
/* How much this pane is actually showing, for the bar above it. Reported from HERE because here is the one place
 * that has already stripped both sides — a toolbar working it out for itself would tokenize the same two files a
 * second time, and could reach a different answer than the panes underneath it. Undefined for a file with no
 * grammar: it renders whole, so git's own counts are the true ones. */
const emit = defineEmits<{ stat: [LineStat | undefined] }>();

const { mobile } = useDevice();
const { ensureMonaco, ensureLanguage } = useMonaco();
const { showComments, toggleShowComments, diffLayout, skipImports } = useLayout();
// The stored preference is a desktop one: two panes cannot fit a phone, so mobile is always inline regardless.
const split = computed(() => !mobile.value && diffLayout.value === `split`);

const host = ref<HTMLElement>();
const diff = shallowRef<Monaco.editor.IStandaloneDiffEditor>();
let original: Monaco.editor.ITextModel | undefined;
let modified: Monaco.editor.ITextModel | undefined;
let lang: string | undefined;
let disposed = false;
/* WHY THERE IS NOTHING TO LOOK AT, when there is nothing to look at. A diff with no hunks renders as either an
 * unmarked file or — once stripping empties both models — two blank panes, and neither says which of the two
 * reasons it is. `comments` has a way out and offers it; `identical` does not, and saying so is the whole fix:
 * the daemon genuinely answers with two equal sides (a file staged and then opened from the unstaged row, a
 * worktree compared against a HEAD that already contains it), and that used to arrive as a blank panel. */
const changeless = ref<"comments" | "identical">();

// Unchanged lines kept next to a change: what a collapsed region leaves either side of the code it hides, and
// the gap above the hunk a diff opens on. One number, because it is one answer to how much of the code around a
// change a reader needs to place it.
const CONTEXT_LINES = 3;

const step = (forward: boolean): void => diff.value?.goToDiff(forward ? `next` : `previous`);

// One side as its pane should show it. Stripping shortens the model, so the gutter has to render the source line
// each kept line came from — Monaco's own numbering would be off by every comment above it.
const side = async (text: string): Promise<{ text: string; lineNumbers: Monaco.editor.LineNumbersType; stripped: boolean }> => {
    const stripped = showComments.value ? undefined : await stripComments(text, lang);
    if (stripped === undefined) {
        return { text, lineNumbers: `on`, stripped: false };
    }
    return { text: stripped.text, lineNumbers: (line) => String(stripped.lines[line - 1] ?? ``), stripped: true };
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
    changeless.value = (before ?? ``) === (after ?? ``) ? `identical` : left.text === right.text ? `comments` : undefined;
    // Unstripped means the reader asked for the comments back, or the file has no grammar — either way what is
    // on screen is the whole file, which is what git already counted.
    emit(`stat`, left.stripped && right.stripped ? lineStat(left.text, right.text) : undefined);
};

/* Land the reader on a change instead of line 1: the change is often mid-file, and Monaco opens at the top,
 * leaving it to be found by scrolling. WHICH change is the reader's preference — the first one, or (skipImports)
 * the first that touches something other than an import, since a file's import list is the change a review keeps
 * opening on and never the one it came for. A change-less result — an identical file, or a diff whose every
 * change was a comment — reveals nothing either way. Call this straight after `render` fills the models. */
const reveal = async (editor: Monaco.editor.IStandaloneDiffEditor): Promise<void> => {
    /* Monaco diffs in a worker, so the hunks are not there yet — its own revealFirstDiff waits that out
     * internally, and choosing a hunk instead means waiting for it here. Subscribed before this function awaits
     * anything, so the update it resolves on is the one the models `render` just filled scheduled: a worker's
     * answer can only arrive in a later task, and the scan below is what we spend the wait on. */
    const recomputed = new Promise<void>((resolve) => {
        const subscription = editor.onDidUpdateDiff(() => {
            subscription.dispose();
            resolve();
        });
    });
    // Only the skipping reader pays for the import scan — a tokenize pass over each side.
    const scan = skipImports.value
        ? await Promise.all([importLines(original?.getValue() ?? ``, lang), importLines(modified?.getValue() ?? ``, lang)])
        : undefined;
    await recomputed;
    if (disposed) {
        return; // unmounted (fast file-switch) while the sides were scanned
    }
    const changes = editor.getLineChanges() ?? [];
    const target =
        scan === undefined
            ? changes[0]
            : firstChangeBeyondImports(
                  changes,
                  { lines: original?.getLinesContent() ?? [], imports: scan[0] },
                  { lines: modified?.getLinesContent() ?? [], imports: scan[1] },
              );
    if (target === undefined) {
        return;
    }
    // A deleted run has no line of its own on the right — Monaco reports the line it followed, which is 0 when
    // the file lost its very first lines.
    const line = Math.max(target.modifiedStartLineNumber, 1);
    const pane = editor.getModifiedEditor();
    pane.setPosition({ lineNumber: line, column: 1 }); // and F7 carries on from there
    /* Scrolled to, rather than revealed: every reveal Monaco offers buys a gap above the change out of the
     * viewport — half of it for revealInCenter (which is what its own diff navigation uses), a fifth for
     * revealNearTop. That gap is unchanged code the reader has no reason to be looking at, and on a tall pane it
     * is most of the screen. The change goes to the top with the same few lines of context the collapsed regions
     * keep, so what fills the viewport under it is the change itself. */
    pane.setScrollTop(pane.getTopForLineNumber(Math.max(line - CONTEXT_LINES, 1)));
};

onMounted(async () => {
    const m = await ensureMonaco();
    /* The SAME call the file viewer settles its tokenizer with, so a file colors identically whether it is being
     * read or reviewed — extension table first, then the shebang for an extensionless script, and nothing at all
     * over the highlight cap. Both panes hold the same file, so whichever side is present names the language (an
     * added or deleted file has only one). The cap sees the larger side, since both get tokenized; character
     * count stands in for the byte size it wants — these props are already-decoded text, and the cap is a guard
     * against tokenizing something enormous, not a byte-exact budget. */
    lang = await ensureLanguage(m, highlightLangFor(path, Math.max(before?.length ?? 0, after?.length ?? 0), after ?? before ?? ``));
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
        // Wrap both panes, on the file viewer's terms (CodeView) — a review pane is HALF the width, so a line
        // that merely fit there now folds instead of hiding its tail behind a horizontal scroll. Monaco passes
        // this to each side through diffWordWrap, whose default is `inherit`; in unified mode it wraps the one
        // visible pane and leaves the hidden original alone. Alignment across the panes is Monaco's own.
        wordWrap: `bounded`,
        wordWrapColumn: 160,
        // Minimap slider + diff overview ruler cover vertical navigation; the per-pane scrollbars are
        // redundant next to them. Size 0 too: `hidden` alone still reserves the 14px strip in the layout.
        // Horizontal only ever appears for what wrapping can't fold (a long token).
        scrollbar: { vertical: `hidden`, verticalScrollbarSize: 0 },
        // Collapse runs of unchanged lines to a few lines of context, like the old collapseUnchanged.
        hideUnchangedRegions: { enabled: true, contextLineCount: CONTEXT_LINES, minimumLineCount: 3, revealLineCount: 20 },
        scrollBeyondLastLine: false,
        renderMarginRevertIcon: false,
        fontFamily: mono,
        ...editorType(),
    });
    diff.value = editor;
    // Empty models first: `render` owns what goes in them, so the toggle and the first paint take one path.
    original = m.editor.createModel(``, lang);
    modified = m.editor.createModel(``, lang);
    editor.setModel({ original, modified });
    await render(editor);
    if (disposed) {
        return; // unmounted (fast file-switch) while the sides were stripped
    }
    // VSCode's diff-navigation keys, on the focused (modified) pane. Registered before the reveal, which may
    // wait on the diff computation — these are the way through a file that is still settling.
    const modifiedEditor = editor.getModifiedEditor();
    modifiedEditor.addCommand(m.KeyCode.F7, () => editor.goToDiff(`next`));
    modifiedEditor.addCommand(m.KeyMod.Shift | m.KeyCode.F7, () => editor.goToDiff(`previous`));
    await reveal(editor);
});

// Crossing the breakpoint (rotation, split-screen) or flipping the toolbar's toggle swaps side-by-side ↔
// unified in place — no rebuild.
watch(split, (on) => diff.value?.updateOptions({ renderSideBySide: on }));

// The app's text size, in place: the diff is the surface most worth resizing and the least willing to do it on
// its own (see editorType).
watchEditorType((type) => diff.value?.updateOptions(type));

watch(showComments, async () => {
    if (diff.value === undefined) {
        return;
    }
    // Revealing on every toggle would yank a scroll position the reader chose. Out of a changeless diff there is
    // no such position — the pane held no change at all — so land on the hunks the toggle un-hid.
    const wasChangeless = changeless.value !== undefined;
    await render(diff.value);
    if (wasChangeless) {
        await reveal(diff.value);
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
        <!-- A diff with no hunks has to explain itself, whichever way it got there: hiding comments can leave
             nothing at all to look at, and so can two sides that were equal to begin with. The first has one
             click that brings the change back; the second has nothing to offer and says only what it is. -->
        <div v-if="changeless !== undefined" class="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center px-9">
            <button
                v-if="changeless === `comments`"
                type="button"
                class="pointer-events-auto flex items-center gap-1.5 rounded-full border border-line bg-card/95 px-3 py-1 text-2xs text-muted shadow-sm backdrop-blur transition-colors hover:text-content"
                @click="toggleShowComments()"
            >
                <Icon name="eye-slash" class="text-2xs" />
                Only comments changed — show them
            </button>
            <p
                v-else
                class="flex items-center gap-1.5 rounded-full border border-line bg-card/95 px-3 py-1 text-2xs text-muted shadow-sm backdrop-blur"
            >
                <Icon name="info-circle" class="text-2xs" />
                No changes — both sides are identical
            </p>
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
