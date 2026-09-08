<script setup lang="ts">
import { DiffStat } from "@intentic/ui";
import { computed } from "vue";
import { useLayout } from "../shell/window/useLayout";
import type { LineStat } from "@intentic/code-read";
import { addedIn, shownStat, weightFill } from "../features/workspace/changes/changeWeight";

// The +/- badge for a changed file; every surface (rows, headings, diff bar) renders through this so their
// numbers agree. Code-only by default, git's raw number is one hover away; a file with no such reading falls
// back to git's, and an all-comments change shows a 'comments' pill, not +0 −0. `of` scales the rail to this reading.

const { code, additions, deletions, of } = defineProps<{
    // Comments-stripped diff, as the daemon counted it; absent when there's no such reading, so git's numbers apply.
    code?: LineStat;
    // Git's own, comments included.
    additions?: number;
    deletions?: number;
    // The largest addition in this list; when present, the rail is drawn and scaled to it.
    of?: number;
}>();

const { showComments } = useLayout();

// True when the surface shows code alone; the only mode where the props above matter.
const stripped = computed(() => !showComments.value);
const shown = computed(() => shownStat(stripped.value, code, additions, deletions));
const commentsOnly = computed(() => stripped.value && code?.additions === 0 && code.deletions === 0 && ((additions ?? 0) > 0 || (deletions ?? 0) > 0));

// Git's reading, formatted the way the badge formats numbers, for the hover text.
const full = computed(() => [additions ? `+${additions}` : ``, deletions ? `−${deletions}` : ``].filter(Boolean).join(` `));
// Only when the two readings differ; otherwise the hover would repeat the number below it.
const hint = computed<string | undefined>(() => {
    if (!stripped.value || code === undefined || (code.additions === (additions ?? 0) && code.deletions === (deletions ?? 0))) {
        return undefined;
    }
    return commentsOnly.value ? `Only comments changed, ${full.value} of them` : `Code only · ${full.value} counting comments`;
});

// Rail: this file's added lines against the list's largest addition (see changeWeight.ts for the compressive
// scale). No rail for a zero-addition row (gap, not an empty track); no tooltip, since the number is already beside it.
const fill = computed<number | undefined>(() => {
    const added = addedIn(shown.value);
    return of === undefined || of <= 0 || added <= 0 ? undefined : weightFill(added, of);
});
</script>

<template>
    <span
        v-if="commentsOnly"
        class="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-overlay px-1 py-px text-2xs text-subtle"
        v-tooltip.top="hint"
    >
        <Icon name="eye-slash" class="text-2xs" />comments
    </span>
    <!-- The hover is the only place both readings appear; the badge itself only ever shows one number. -->
    <span v-else-if="hint !== undefined" class="inline-flex shrink-0" v-tooltip.top="hint">
        <DiffStat :additions="shown.additions" :deletions="shown.deletions" />
    </span>
    <DiffStat v-else :additions="shown.additions" :deletions="shown.deletions" />
    <!-- Follows the numbers so bars share a right edge despite variable-width counts; aria-hidden, decorative only. -->
    <span v-if="fill !== undefined" class="flex h-0.75 w-5 shrink-0 overflow-hidden rounded-full bg-overlay" aria-hidden="true">
        <span class="h-full rounded-full bg-success" :style="{ width: `${fill * 100}%` }"></span>
    </span>
</template>
