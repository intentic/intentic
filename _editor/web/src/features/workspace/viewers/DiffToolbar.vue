<script setup lang="ts">
import { ChangeStatusMark, SegmentedControl, useDevice } from "@intentic/ui";
import type { DiffLayout } from "../../../shell/window/useLayout";
import { useLayout } from "../../../shell/window/useLayout";
import type { ChangeStatus } from "@intentic/extension-api";
import { basename, parentDir } from "@intentic/ui/path";
import ReviewStat from "../../../components/ReviewStat.vue";
import type { LineStat } from "@intentic/code-read";

// Bar above a diff: which file, and how it's read. Shared by every diff surface (workspace tab, agent review,
// environment card). Owns only the reading settings (comments, split/unified), global via useLayout since that's a
// habit, not per-file; never the file's place in a review (viewed tick, next-file arrows, open-in-editor) — those
// arrive through slots, in render order:
// lead → before the path (the phone's back arrow out of a full-screen diff).
// badges → after the path (a blocked/not-landed mark, a property of the file).
// actions → after the reading controls (the host's own file-scoped buttons).

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

const { mobile } = useDevice();
const { showComments, toggleShowComments, diffLayout, setDiffLayout } = useLayout();

// Desktop-only; DiffView forces unified on a phone without overwriting the stored preference.
const LAYOUT_OPTIONS: { label: string; value: DiffLayout }[] = [
    { label: `Split`, value: `split` },
    { label: `Unified`, value: `unified` },
];
</script>

<template>
    <!--
        @container: what fits is a fact about the viewer's own width, not the viewport. `max-md:` is only touch-target
        height, not layout.
    -->
    <div class="@container flex h-8 shrink-0 items-center gap-1.5 border-b border-line px-2 max-md:h-12">
        <slot name="lead" />
        <ChangeStatusMark v-if="status !== undefined" :status="status" />
        <!--
            Directory dimmed and leading, basename legible: matches the review row's reading order. Only the directory
            truncates, or the bar would ellipsize the more useful half of the path.
        -->
        <!--
            Tooltip sits on the directory span, the element that actually truncates; on the flex wrapper it never fires,
            since the wrapper itself never overflows.
        -->
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
        <SegmentedControl v-if="!mobile" :model-value="diffLayout" :options="LAYOUT_OPTIONS" size="xs" @update:model-value="setDiffLayout" />
        <!-- Labelled, not just a glyph: a default that silently removes lines has to keep saying so at a glance. -->
        <button
            type="button"
            class="ui-chip shrink-0 justify-center gap-1 rounded-md px-1.5 py-0.5 font-medium max-md:h-9 max-md:w-9"
            :class="showComments ? `ui-chip-on` : ``"
            :aria-pressed="showComments"
            v-tooltip.bottom="showComments ? 'Comments shown, click to diff the code alone' : 'Comments hidden, click to show them'"
            @click="toggleShowComments()"
        >
            <Icon class="text-2xs" :name="showComments ? `eye` : `eye-slash`" />
            <span class="max-md:hidden">Comments</span>
        </button>
        <slot name="actions" />
    </div>
</template>
