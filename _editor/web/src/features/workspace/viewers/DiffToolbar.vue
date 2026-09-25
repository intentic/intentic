<script setup lang="ts">
import { ChangeStatusMark, type IconName, ResponsiveOverlay, SegmentedControl, ui, useDevice } from "@intentic/ui";
import { computed, ref, useSlots } from "vue";
import type { DiffLayout } from "../../../shell/window/useLayout";
import { useLayout } from "../../../shell/window/useLayout";
import type { ChangeStatus } from "@intentic/extension-api";
import { basename, parentDir } from "@intentic/ui/path";
import ReviewStat from "../../../components/ReviewStat.vue";
import type { LineStat } from "@intentic/code-read";
import { extensionOf, formatOf } from "@intentic/ui/file-format";
import { rendersAsBytes } from "../explorer/fileType";
import { compareViewerForExtension } from "../../../core-views/viewerRegistry";
import { useT } from "@intentic/ui/i18n";

// Bar above a diff: which file, and how it's read. Shared by every diff surface (workspace tab, agent review,
// environment card).
//
// The bar itself carries only what changes with the file — mark, path, badges, its ± — because that is what a reader
// scanning a review looks at. Everything about HOW a diff reads (comments, split/unified, a document's reading) is a
// sticky global habit, not a property of the file, so it sits behind one control at the end of the row instead of
// spending the row's width on settings that change a few times a year. That control's glyph still states the one
// setting that silently withholds lines (comments), since a default that removes them has to keep saying so.
//
// Never the file's place in a review (viewed tick, next-file arrows) — that arrives through slots, in render order:
// lead → before the path (the phone's back arrow out of a full-screen diff).
// badges → after the path (a blocked/not-landed mark, a property of the file).
// actions → after the reading controls (the host's own file-scoped buttons).
// settings → rows inside the reading popover, for a host action that is rare enough to belong there (`item` is the
//   row class, passed down so one definition dresses every row in the panel).

const t = useT();

const { path, status, code, additions, deletions, from } = defineProps<{
    // Repo-qualified where the surface knows the repo: this is a label to read, not a key.
    path: string;
    status?: ChangeStatus;
    // Counts with comments stripped, for the pane below unless toggled off; absent falls back to git's counts.
    code?: LineStat;
    additions?: number;
    deletions?: number;
    // Where a rename came from, printed as `← old/path` on the surfaces that track renames.
    from?: string;
}>();

const slots = useSlots();
const { mobile } = useDevice();
const { showComments, toggleShowComments, diffLayout, setDiffLayout, diffProse, setDiffProse, diffDocument, setDiffDocument } = useLayout();

// A document offers a second reading, tracked changes over the text; code has only the code. In the prose reading the
// layout and comment controls have nothing to act on, so they step aside.
const format = computed(() => formatOf(path).reads);
const prose = computed(() => format.value === `markdown` || format.value === `plain`);
const proseOn = computed(() => prose.value && diffProse.value);
const READING_OPTIONS = computed(() => [
    { label: t(`workspace.diffToolbar.prose`), value: `prose`, title: t(`workspace.diffToolbar.textWhatAddedUnderlined`) },
    { label: t(`workspace.words.code`), value: `code`, title: t(`workspace.diffToolbar.filesLinesSideBy`) },
]);

// A binary document (a .docx, a .pdf, a deck) reads either as tracked changes over the text rendered from it or as its
// two versions drawn whole; a notebook's other reading is its JSON, and a csv reads as a grid or as its lines. All
// share one preference, since each pair is "the structure" against "the raw file". Comments never apply to either.
// A format whose viewer can draw the two versions as one marked document (a .docx) has three: that redline, the text,
// and the two versions; elsewhere a stored `text` reads as the Changes it is.
const document = computed(() => format.value === `document` || format.value === `table`);
const documentChanges = computed(() => document.value && diffDocument.value !== `sides`);
const redline = computed(() => format.value === `document` && compareViewerForExtension(extensionOf(path)) !== undefined);
const documentReading = computed(() => (diffDocument.value === `text` && !redline.value ? `changes` : diffDocument.value));
const DOCUMENT_OPTIONS = computed(() => {
    if (format.value === `table`) {
        return [
            { label: t(`workspace.diffToolbar.table`), value: `changes`, title: t(`workspace.diffToolbar.rowsAndCellsChangedMarked`) },
            { label: t(`workspace.words.code`), value: `sides`, title: t(`workspace.diffToolbar.filesLinesSideBy`) },
        ];
    }
    if (redline.value) {
        return [
            { label: t(`workspace.diffToolbar.changes`), value: `changes`, title: t(`workspace.diffToolbar.documentDrawnWordsMarked`) },
            { label: t(`workspace.words.text`), value: `text`, title: t(`workspace.diffToolbar.textOfBothVersionsAgentReads`) },
            { label: t(`workspace.diffToolbar.beforeAfter`), value: `sides`, title: t(`workspace.diffToolbar.bothVersionsDrawnWhole`) },
        ];
    }
    return [
        { label: t(`workspace.diffToolbar.changes`), value: `changes`, title: t(`workspace.diffToolbar.documentTextWhatAdded`) },
        rendersAsBytes(path, undefined)
            ? { label: t(`workspace.diffToolbar.beforeAfter`), value: `sides`, title: t(`workspace.diffToolbar.bothVersionsDrawnWhole`) }
            : { label: t(`workspace.words.code`), value: `sides`, title: t(`workspace.diffToolbar.filesLinesSideBy`) },
    ];
});

// Desktop-only; DiffView forces unified on a phone without overwriting the stored preference.
const LAYOUT_OPTIONS = computed((): { label: string; value: DiffLayout }[] => [
    { label: t(`workspace.diffToolbar.split`), value: `split` },
    { label: t(`workspace.diffToolbar.unified`), value: `unified` },
]);
const COMMENT_OPTIONS = computed(() => [
    { label: t(`workspace.diffToolbar.shown`), value: `shown` as const },
    { label: t(`workspace.diffToolbar.hidden`), value: `hidden` as const },
]);
// The preference is a toggle, the control is a pair: pressing the pill already lit must not flip it back.
const setComments = (value: string): void => {
    if ((value === `shown`) !== showComments.value) {
        toggleShowComments();
    }
};

// Which rows the popover has to offer for THIS file; with none of them the button has nothing to open.
const layoutRow = computed(() => !mobile.value && !proseOn.value && !documentChanges.value);
const commentsRow = computed(() => !proseOn.value && !document.value);
const hosted = computed(() => slots[`settings`] !== undefined);
const reads = computed(() => prose.value || document.value || layoutRow.value || commentsRow.value || hosted.value);

// The two things the closed button still has to say: that lines may be missing, and what pressing it is about. The
// glyph carries the first (comments are hidden by default, so the eye is struck through most of the time); the
// summary carries the rest, in the same words the rows inside use.
const readingGlyph = computed<IconName>(() => (commentsRow.value ? (showComments.value ? `eye` : `eye-slash`) : `sliders-h`));
const readingSummary = computed(() =>
    [
        layoutRow.value ? LAYOUT_OPTIONS.value.find((option) => option.value === diffLayout.value)?.label : undefined,
        commentsRow.value ? (showComments.value ? t(`workspace.diffToolbar.commentsShown`) : t(`workspace.diffToolbar.commentsHidden`)) : undefined,
    ]
        .filter((part) => part !== undefined)
        .join(` · `),
);

const readingAnchor = ref<HTMLElement | null>(null);
const readingOpen = ref(false);

// One row shape for every setting, and for whatever a host hangs below them: label left, control right.
const ROW = `flex items-center justify-between gap-3 rounded-lg px-2 py-1.5`;
const ITEM = `${ROW} w-full cursor-pointer text-left transition-colors hover:bg-overlay max-md:py-3`;
const LABEL = `text-2xs text-content max-md:text-sm`;
</script>

<template>
    <!-- @container: what fits is a fact about the viewer's own width, not the viewport. -->
    <div class="@container flex h-8 shrink-0 items-center gap-1.5 border-b border-line px-2 max-md:h-12">
        <slot name="lead" />
        <ChangeStatusMark v-if="status !== undefined" :status="status" />
        <!-- Directory dimmed and leading, basename legible: matches the review row's reading order. -->
        <!-- Tooltip sits on the directory span, the element that actually truncates; on the flex wrapper it never fires, since the wrapper itself never overflows. -->
        <span class="flex min-w-0 flex-1 items-baseline text-2xs max-md:text-xs">
            <span v-if="parentDir(path) !== ''" class="min-w-0 truncate text-subtle" v-tooltip.bottom.overflow="path">{{ parentDir(path) }}/</span>
            <span class="shrink-0 font-medium text-content">{{ basename(path) }}</span>
        </span>
        <span
            v-if="from !== undefined"
            class="hidden max-w-40 truncate font-mono text-2xs text-subtle @xl:inline-block"
            v-tooltip.bottom.overflow="from"
        >
            ← {{ from }}
        </span>
        <slot name="badges" />
        <ReviewStat :code="code" :additions="additions" :deletions="deletions" />
        <slot name="actions" />
        <!-- Last in the row, after the file's own actions: the settings are about every file, so they sit outside them. -->
        <button
            v-if="reads"
            ref="readingAnchor"
            type="button"
            :class="ui.iconButton(`w-auto gap-0.5 px-1 max-md:h-9`, readingOpen ? `bg-overlay text-content` : ``)"
            :aria-expanded="readingOpen"
            :aria-label="t(`workspace.diffToolbar.howThisReads`)"
            v-tooltip.bottom="readingSummary === `` ? t(`workspace.diffToolbar.howThisReads`) : readingSummary"
            @click="readingOpen = !readingOpen"
        >
            <Icon :name="readingGlyph" class="text-2xs" />
            <Icon name="chevron-down" class="text-3xs opacity-60" />
        </button>
        <ResponsiveOverlay
            v-model="readingOpen"
            :anchor="readingAnchor ?? undefined"
            :header="t(`workspace.diffToolbar.howThisReads`)"
            side="bottom"
            cross="end"
            panel-class="w-72 p-1"
        >
            <div :class="ROW" v-if="prose">
                <span :class="LABEL">{{ t(`workspace.diffToolbar.reading`) }}</span>
                <SegmentedControl
                    :model-value="proseOn ? `prose` : `code`"
                    :options="READING_OPTIONS"
                    size="xs"
                    @update:model-value="(value: string) => setDiffProse(value === `prose`)"
                />
            </div>
            <div :class="ROW" v-if="document">
                <span :class="LABEL">{{ t(`workspace.diffToolbar.reading`) }}</span>
                <SegmentedControl
                    :model-value="documentReading"
                    :options="DOCUMENT_OPTIONS"
                    size="xs"
                    @update:model-value="(value: string) => setDiffDocument(value === `changes` ? `changes` : value === `text` ? `text` : `sides`)"
                />
            </div>
            <div :class="ROW" v-if="layoutRow">
                <span :class="LABEL">{{ t(`workspace.diffToolbar.layout`) }}</span>
                <SegmentedControl :model-value="diffLayout" :options="LAYOUT_OPTIONS" size="xs" @update:model-value="setDiffLayout" />
            </div>
            <div :class="ROW" v-if="commentsRow">
                <span :class="LABEL">{{ t(`workspace.words.comments`) }}</span>
                <SegmentedControl
                    :model-value="showComments ? `shown` : `hidden`"
                    :options="COMMENT_OPTIONS"
                    size="xs"
                    @update:model-value="setComments"
                />
            </div>
            <!-- A host's own rare action, dressed as one of these rows rather than as a seventh glyph in the bar. Ruled
                 off from the settings above it, since an act and a preference should not read as the same kind of row. -->
            <div v-if="hosted" class="mt-1 border-t border-line/60 pt-1">
                <slot name="settings" :item="ITEM" :label="LABEL" :close="() => (readingOpen = false)" />
            </div>
        </ResponsiveOverlay>
    </div>
</template>
