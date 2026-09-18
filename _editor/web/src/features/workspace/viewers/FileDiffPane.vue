<script setup lang="ts">
import type { PartialFileDiff } from "@intentic/sandbox-contract";
import { formatBytes } from "@intentic/ui";
import { computed } from "vue";
import { type LineStat, nameExt } from "@intentic/code-read";
import { isDelimitedPath, isDocumentPath, isProsePath, rendersAsBytes } from "../explorer/fileType";
import { useLayout } from "../../../shell/window/useLayout";
import { compareViewerForExtension } from "../../../core-views/viewerRegistry";
import { derivedDiffSource } from "../changes/diffRaw";
import BinaryDiffView from "./BinaryDiffView.vue";
import CompareDiffView from "./CompareDiffView.vue";
import DerivedDiffView from "./DerivedDiffView.vue";
import { patchedSides } from "./diffPatch";
import DiffView from "./DiffView.vue";
import ProseDiffView from "./ProseDiffView.vue";
import { sheetOfDelimited } from "./tableDiff";
import TableDiffView from "./TableDiffView.vue";

// One file's diff, whichever of seven shapes it arrives in; every review surface (Changes tab, phone, agent
// review) renders this same fork. Loading state stays with the host; content does not. The seven shapes, decided
// in this order:
// redline → a document whose viewer draws its two versions as one, what changed marked in place (CompareDiffView),
// when the toolbar's reading is Changes and both sides' bytes are named.
// document → a .docx, .pdf, deck or notebook read as tracked changes over the text the daemon renders from each
// version (DerivedDiffView), while the toolbar's reading says so and the surface named where the sides live.
// table → a .csv/.tsv read as a grid of cells (TableDiffView), under the same reading; its lines are the other one.
// bytes → no text to diff isn't nothing to see: a .png renders as its two sides, a .docx as two documents.
// partial → too big to send whole; rebuilt from the daemon's patch into two sides with the file's own line
// numbers, under a bar stating what's shown.
// nothing → partial with no patch to show; only the sizes are said.
// text → the ordinary case, both whole sides.
const { path, before, after, binary, partial, beforeRaw, afterRaw, at } = defineProps<{
    path: string;
    before?: string;
    after?: string;
    binary?: boolean;
    // Set when the file was too big to ship as two sides: what came instead (PartialFileDiff, diffPatch.ts).
    partial?: PartialFileDiff;
    // Where the two sides' bytes live, for a diff the response could only flag as binary (daemon /diff/raw).
    beforeRaw?: string;
    afterRaw?: string;
    // Sandbox the raw URLs are on, absent for the active one; only the binary path re-fetches from a daemon.
    at?: string;
}>();
// Code-only change stat, forwarded from whichever viewer renders (DiffView decides the partial-diff case).
const emit = defineEmits<{ stat: [LineStat | undefined] }>();

// A document's whole two sides read as tracked changes when the toolbar's reading says so (DiffToolbar, the same
// preference); a partial or binary diff has no text to word.
const { diffProse, diffDocument, setDiffDocument } = useLayout();
const prose = computed(() => diffProse.value && isProsePath(path));

// The viewer drawing this document's two versions as one, with both sides' bytes to hand it; a one-sided diff (a
// file added or deleted) has nothing to align and reads as text.
const redline = computed(() => {
    const compare = isDocumentPath(path) && diffDocument.value === `changes` ? compareViewerForExtension(nameExt(path).ext)?.compare : undefined;
    return compare !== undefined && beforeRaw !== undefined && afterRaw !== undefined ? { compare, before: beforeRaw, after: afterRaw } : undefined;
});

// The derived-text reading of a document, when the side URLs name a diff the daemon can render both versions of.
const source = computed(() => derivedDiffSource({ beforeRaw, afterRaw }));
const derived = computed(() => redline.value === undefined && diffDocument.value !== `sides` && isDocumentPath(path) && source.value !== undefined);

// Delimited text as a grid, when whole sides are here to parse; a partial (oversized) csv keeps the line diff.
const table = computed(() => diffDocument.value !== `sides` && isDelimitedPath(path) && partial === undefined);
const filename = computed(() => path.slice(path.lastIndexOf(`/`) + 1));
const beforeSheets = computed(() => (before === undefined ? [] : [sheetOfDelimited(before, filename.value)]));
const afterSheets = computed(() => (after === undefined ? [] : [sheetOfDelimited(after, filename.value)]));

// Patch unpicked into two sides plus each line's file line; undefined when there's no patch, or no regions.
const patched = computed(() => (partial?.patch === undefined ? undefined : patchedSides(partial.patch, partial.more === true)));

// Size of what isn't shown, per side that exists; an added file reads as one number, not "0 B → 4.1 MB".
const size = computed(() => {
    const from = partial?.beforeBytes;
    const to = partial?.afterBytes;
    if (from !== undefined && to !== undefined) {
        return from === to ? formatBytes(to) : `${formatBytes(from)} → ${formatBytes(to)}`;
    }
    return formatBytes(to ?? from ?? 0);
});

// Answers two things at once: why this isn't the whole file, and whether what's shown is the whole change,
// since assuming so risks approving unread work. A one-sided file is whole by definition, never "N changed regions".
const note = computed(() => {
    const regions = patched.value?.regions;
    if (regions === undefined) {
        return `${size.value} — too large to diff in the browser, and the change too large to send as a patch.`;
    }
    if (partial?.beforeBytes === undefined || partial.afterBytes === undefined) {
        return partial?.more === true ? `${size.value} — the start of it; too large to show whole.` : `${size.value} — the whole file.`;
    }
    const counted = `${regions} changed ${regions === 1 ? `region` : `regions`}`;
    return partial.more === true
        ? `${size.value} — the first ${counted}; more follow further down the file.`
        : `${size.value} — ${counted}; the rest of the file is unchanged.`;
});
</script>

<template>
    <CompareDiffView
        v-if="redline"
        :path="path"
        :before="redline.before"
        :after="redline.after"
        :at="at"
        :compare="redline.compare"
        @text="setDiffDocument(`text`)"
        @sides="setDiffDocument(`sides`)"
    />
    <DerivedDiffView v-else-if="derived && source" :path="path" :source="source" :at="at" @sides="setDiffDocument(`sides`)" />
    <BinaryDiffView v-else-if="rendersAsBytes(path, binary)" :path="path" :before="beforeRaw" :after="afterRaw" :at="at" />
    <TableDiffView v-else-if="table" :before="beforeSheets" :after="afterSheets" />
    <div v-else-if="partial !== undefined" class="flex h-full min-h-0 flex-col">
        <div class="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5 text-2xs text-muted">
            <Icon :name="patched ? `compress` : `info-circle`" class="shrink-0 text-[0.7rem]" />
            <span class="min-w-0 truncate" v-tooltip.bottom.overflow="note">{{ note }}</span>
        </div>
        <div v-if="patched" class="min-h-0 flex-1">
            <DiffView
                :before="patched.before"
                :after="patched.after"
                :path="path"
                :lines="{ before: patched.beforeLines, after: patched.afterLines }"
                @stat="(stat) => emit(`stat`, stat)"
            />
        </div>
    </div>
    <ProseDiffView v-else-if="prose" :before="before" :after="after" />
    <DiffView v-else :before="before" :after="after" :path="path" @stat="(stat) => emit(`stat`, stat)" />
</template>
