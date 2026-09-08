<script setup lang="ts">
import { useDevice } from "@intentic/ui";
import type * as Monaco from "monaco-editor-core";
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { useLayout } from "../../../shell/window/useLayout";
import { highlightLangFor, lineStat, type CodeAnalysis, type LineStat } from "@intentic/code-read";
import { requestCodeAnalysis } from "../health/codeAnalysisClient";
import { landingChange, type ImportSide } from "../health/codeLanding";
import { editorType, useMonaco, watchEditorType } from "../files/useMonaco";
import { PATCH_GAP } from "./diffPatch";

// Diff of one file (before=parent, after=snapshot) via Monaco's diff editor, VSCode's engine: side-by-side with
// a minimap per pane on desktop, inline on mobile (chunk nav via buttons). Read-only, uncontrolled, remounted per
// file via :key. Comments strip from both sides unless the reader asks (useLayout.showComments via DiffToolbar).

const { before, after, path, lines } = defineProps<{
    before?: string;
    after?: string;
    path: string;
    // Model line → file line, for a partial diff (diffPatch.ts); 0 = gap marker; absent for a whole-file diff.
    lines?: { readonly before: readonly number[]; readonly after: readonly number[] };
}>();
// Line stats for the toolbar, from here since both sides are already stripped; undefined falls back to git's.
const emit = defineEmits<{ stat: [LineStat | undefined] }>();

const { mobile } = useDevice();
const { ensureMonaco, ensureLanguage } = useMonaco();
const { showComments, toggleShowComments, diffLayout, diffOpen } = useLayout();
// The stored preference is a desktop one: two panes cannot fit a phone, so mobile is always inline regardless.
const split = computed(() => !mobile.value && diffLayout.value === `split`);

const host = ref<HTMLElement>();
const diff = shallowRef<Monaco.editor.IStandaloneDiffEditor>();
let original: Monaco.editor.ITextModel | undefined;
let modified: Monaco.editor.ITextModel | undefined;
// Two distinct language ids: `modelLang` is what Monaco tokenizes with (undefined if unbridged); `stripLang` is
// what the comment strip and count store both resolve from the path, sharing one cache entry so they agree.
let modelLang: string | undefined;
let stripLang: string | undefined;
let disposed = false;
let importSides: readonly [ImportSide, ImportSide] = [
    { lines: [], imports: new Set() },
    { lines: [], imports: new Set() },
];
// Distinguishes an empty diff caused by hidden comments (`comments`, offer to show them) from truly identical
// sides (`identical`, nothing to offer).
const changeless = ref<"comments" | "identical">();

// Unchanged lines kept beside a change: collapsed-region margin, and the landing gap above an opened hunk.
const CONTEXT_LINES = 3;

const step = (forward: boolean): void => diff.value?.goToDiff(forward ? `next` : `previous`);

// One side as its pane shows it; stripping shortens the model, so the gutter must render each line's source,
// not Monaco's own count.
interface DisplaySide {
    readonly text: string;
    readonly lineNumbers: Monaco.editor.LineNumbersType;
    readonly stripped: boolean;
    readonly imports: ReadonlySet<number>;
}

const modelImports = (analysis: CodeAnalysis): ReadonlySet<number> => {
    const sourceImports = new Set(analysis.imports);
    const imports = new Set<number>();
    for (const [index, source] of analysis.code.lines.entries()) {
        if (sourceImports.has(source)) {
            imports.add(index + 1);
        }
    }
    return imports;
};

// Gutter as a lookup, not a count: strip and partial-diff line maps compose in order (strip → text line, then
// source → file line), or a hunk at line 4,182 gets labelled 12.
const gutter = (source: readonly number[] | undefined, strip: readonly number[] | undefined): Monaco.editor.LineNumbersType => {
    if (source === undefined) {
        return strip === undefined ? `on` : (line) => String(strip[line - 1] ?? ``);
    }
    const fileLine = (line: number): number => source[(strip === undefined ? line : (strip[line - 1] ?? 0)) - 1] ?? 0;
    // 0 is a gap marker between two regions: it came from nowhere in the file, so it gets no number.
    return (line) => (fileLine(line) === 0 ? `` : String(fileLine(line)));
};

// Gap markers are Monaco decorations, not literal text; one collection per pane so re-render replaces marks,
// not stacks them. Styled from file-viewer.css, since Monaco's imperative rows can't take a scoped rule.
const gapMarks = new WeakMap<Monaco.editor.ICodeEditor, Monaco.editor.IEditorDecorationsCollection>();
const markGaps = (pane: Monaco.editor.ICodeEditor, text: string): void => {
    const marks = text.split(`\n`).flatMap((line, index) =>
        line === PATCH_GAP
            ? [
                  {
                      range: { startLineNumber: index + 1, startColumn: 1, endLineNumber: index + 1, endColumn: 1 },
                      options: { isWholeLine: true, className: `ws-diff-gap` },
                  },
              ]
            : [],
    );
    const existing = gapMarks.get(pane);
    if (existing !== undefined) {
        existing.set(marks);
        return;
    }
    gapMarks.set(pane, pane.createDecorationsCollection(marks));
};

const side = async (text: string, source: readonly number[] | undefined): Promise<DisplaySide> => {
    // Analysis needed to hide comments, or when landing also needs imports; usually served from cache.
    const analysis = !showComments.value || diffOpen.value !== `top` ? await requestCodeAnalysis(text, stripLang) : undefined;
    if (showComments.value || analysis === undefined) {
        return { text, lineNumbers: gutter(source, undefined), stripped: false, imports: new Set(analysis?.imports ?? []) };
    }
    return {
        text: analysis.code.text,
        lineNumbers: gutter(source, analysis.code.lines),
        stripped: true,
        imports: modelImports(analysis),
    };
};

// Load both sides into the panes. Also the toggle's whole effect: same editor, same file, comments in or out.
const render = async (editor: Monaco.editor.IStandaloneDiffEditor): Promise<void> => {
    const [left, right] = await Promise.all([side(before ?? ``, lines?.before), side(after ?? ``, lines?.after)]);
    if (disposed) {
        return; // unmounted (fast file-switch) while the grammar tokenized
    }
    original?.setValue(left.text);
    modified?.setValue(right.text);
    editor.getOriginalEditor().updateOptions({ lineNumbers: left.lineNumbers });
    editor.getModifiedEditor().updateOptions({ lineNumbers: right.lineNumbers });
    // Re-marked on every render because the strip moves the markers up and down the model.
    markGaps(editor.getOriginalEditor(), left.text);
    markGaps(editor.getModifiedEditor(), right.text);
    importSides = [
        { lines: left.text.split(`\n`), imports: left.imports },
        { lines: right.text.split(`\n`), imports: right.imports },
    ];
    changeless.value = (before ?? ``) === (after ?? ``) ? `identical` : left.text === right.text ? `comments` : undefined;
    // Unstripped means whole-file, already counted by git; a partial diff never counts, only an excerpt is shown.
    emit(`stat`, left.stripped && right.stripped && lines === undefined ? lineStat(left.text, right.text) : undefined);
};

// Lands the reader on a change instead of line 1, per useLayout.diffOpen (first change, first non-import change,
// or heaviest block; via codeLanding). No-ops on a changeless diff. Call right after `render` fills the models.
const reveal = async (editor: Monaco.editor.IStandaloneDiffEditor): Promise<void> => {
    // Monaco diffs in a worker; subscribes before any await, so it can't miss the update render's fill scheduled.
    const recomputed = new Promise<void>((resolve) => {
        const subscription = editor.onDidUpdateDiff(() => {
            subscription.dispose();
            resolve();
        });
    });
    await recomputed;
    if (disposed) {
        return; // unmounted (fast file-switch) while the sides were scanned
    }
    const changes = editor.getLineChanges() ?? [];
    const target = landingChange(diffOpen.value, changes, importSides[0], importSides[1]);
    if (target === undefined) {
        return;
    }
    // A deleted run has no right-side line; Monaco reports the line it followed, 0 if the first lines were lost.
    const line = Math.max(target.modifiedStartLineNumber, 1);
    const pane = editor.getModifiedEditor();
    pane.setPosition({ lineNumber: line, column: 1 }); // and F7 carries on from there
    // Scrolled exactly, not revealed: Monaco's reveal* wastes viewport space above the change, unlike this.
    pane.setScrollTop(pane.getTopForLineNumber(Math.max(line - CONTEXT_LINES, 1)));
};

onMounted(async () => {
    const m = await ensureMonaco();
    // Same call the file viewer uses, so colors match; cap checks the larger side's char count as a byte-size proxy.
    stripLang = highlightLangFor(path, Math.max(before?.length ?? 0, after?.length ?? 0), after ?? before ?? ``);
    modelLang = await ensureLanguage(m, stripLang);
    if (disposed || host.value === undefined) {
        return; // unmounted (fast file-switch) while Monaco/grammar loaded
    }
    const mono = getComputedStyle(document.documentElement).getPropertyValue(`--font-mono`).trim() || `monospace`;
    const editor = m.editor.createDiffEditor(host.value, {
        readOnly: true,
        originalEditable: false,
        automaticLayout: true,
        renderSideBySide: split.value,
        // Always-visible slider: with scrollbars off, a hover-only slider would leave no position indicator at all.
        minimap: { enabled: true, showSlider: `always` },
        // Wraps both panes: a half-width pane folds lines the full-width file viewer wouldn't have to.
        wordWrap: `bounded`,
        wordWrapColumn: 160,
        // Scrollbar redundant beside the minimap slider and diff ruler; size 0 too, since `hidden` reserves space.
        scrollbar: { vertical: `hidden`, verticalScrollbarSize: 0 },
        // Collapses unchanged runs; off for a partial diff, which would otherwise hide its own gap marker.
        hideUnchangedRegions: { enabled: lines === undefined, contextLineCount: CONTEXT_LINES, minimumLineCount: 3, revealLineCount: 20 },
        scrollBeyondLastLine: false,
        renderMarginRevertIcon: false,
        fontFamily: mono,
        ...editorType(`diff`),
    });
    diff.value = editor;
    // Empty models first: `render` owns what goes in them, so the toggle and the first paint take one path.
    original = m.editor.createModel(``, modelLang);
    modified = m.editor.createModel(``, modelLang);
    editor.setModel({ original, modified });
    await render(editor);
    if (disposed) {
        return; // unmounted (fast file-switch) while the sides were stripped
    }
    // VSCode's diff-nav keys on the modified pane, bound before reveal, which may still be waiting on the diff.
    const modifiedEditor = editor.getModifiedEditor();
    modifiedEditor.addCommand(m.KeyCode.F7, () => editor.goToDiff(`next`));
    modifiedEditor.addCommand(m.KeyMod.Shift | m.KeyCode.F7, () => editor.goToDiff(`previous`));
    await reveal(editor);
});

// Breakpoint crossing or the toolbar toggle swaps side-by-side/unified in place, no rebuild.
watch(split, (on) => diff.value?.updateOptions({ renderSideBySide: on }));

// App text size applied in place; the diff is the surface most worth resizing without a remount.
watchEditorType((type) => diff.value?.updateOptions(type), `diff`);

watch(showComments, async () => {
    if (diff.value === undefined) {
        return;
    }
    // Reveals only out of a changeless diff, since otherwise it would yank a scroll position the reader chose.
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
        <!--
            Explains an empty diff either way: hidden comments (one click undoes it) or genuinely identical sides
            (nothing to offer).
        -->
        <div v-if="changeless !== undefined" class="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center px-9">
            <button
                v-if="changeless === `comments`"
                type="button"
                class="ui-chip pointer-events-auto gap-1.5 border-line bg-card/95 px-3 py-1 shadow-sm backdrop-blur"
                @click="toggleShowComments()"
            >
                <Icon name="eye-slash" class="text-2xs" />
                Only comments changed: show them
            </button>
            <p
                v-else
                class="flex items-center gap-1.5 rounded-full border border-line bg-card/95 px-3 py-1 text-2xs text-muted shadow-sm backdrop-blur"
            >
                <Icon name="info-circle" class="text-2xs" />
                No changes: both sides are identical
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
