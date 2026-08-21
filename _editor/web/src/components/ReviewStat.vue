<script setup lang="ts">
import { DiffStat } from "@intentic/ui";
import { computed } from "vue";
import { useLayout } from "../composables/useLayout";
import type { LineStat } from "../composables/workspace/codeStat";

/* A changed file's +/− IN THE READING THE SURFACE IS SHOWING: the review's rows and headings, and the bar over
 * the open diff. Every one of them renders this rather than DiffStat directly, because the choice it makes has
 * to be the same choice in all of them: a header that disagrees with the sum of its rows is worse than either
 * number on its own.
 *
 * With comments hidden (the default) the diff is computed on code alone, so the counts are too. Git's own are
 * one hover away and are what the change will land as: the two readings are never both on screen as bare
 * numbers, because two totals side by side is a question, not an answer.
 *
 * A COUNT THAT IS NOT SETTLED YET IS STILL A COUNT, AND IT IS GIT'S: held at half weight, with the hover saying
 * what is still being worked out. This is the rule that replaced a pending mark, and the mark is what earned the
 * replacement: the code-only reading needs both whole sides of a file, which is a daemon read the background
 * reader takes in its own time, so on the workspace Changes panel: beside an agent that is still writing, which
 * is when that list is longest: EVERY row drew three dots and the panel showed no numbers at all. A number the
 * reader can scan, marked as provisional, beats the honest blank that told them nothing; what the mark was
 * protecting against (a number moving under the reader when a click reads the file) is what the half weight and
 * the hover now say out loud. A file with NOTHING TO STRIP (no grammar, bytes, too big to send) is a settled
 * answer at full weight: git's numbers are what its pane shows, line for line.
 *
 * A change that is ENTIRELY comments would otherwise render as +0 −0, which is the badge's way of saying "a
 * rename" and reads as nothing happened. It says what it is instead, and stays in the list: something did change
 * here, and hiding the row would be the reader's decision to make, not this component's. */

const { code, counting, additions, deletions } = defineProps<{
    // Code-only counts, once the file has been read and stripped. Absent when the file has no grammar to strip:
    // whose pane shows every line it has, making git's numbers the honest ones.
    code?: LineStat;
    // True while the reading is still being worked out: the file has not been read, so git's count is the only
    // one there is and it is shown as provisional. A total is `counting` when ANY row under it is (see
    // sumCounts): part of a sum is not a sum.
    counting?: boolean;
    // Git's own, comments included.
    additions?: number;
    deletions?: number;
}>();

const { showComments } = useLayout();

// Whether the surface is showing code alone: the only mode in which any of the above matters.
const stripped = computed(() => !showComments.value);
// Git's count standing in for one that has not been worked out yet, and therefore the one reading here that is
// allowed to change. Drawn at half weight, said in the hover.
const provisional = computed(() => stripped.value && counting === true);
const shown = computed(() => (stripped.value && code !== undefined ? code : { additions, deletions }));
const commentsOnly = computed(
    () => stripped.value && !provisional.value && code?.additions === 0 && code.deletions === 0 && ((additions ?? 0) > 0 || (deletions ?? 0) > 0),
);

// Git's reading, spelled the way the badge spells it, for the hover.
const full = computed(() => [additions ? `+${additions}` : ``, deletions ? `−${deletions}` : ``].filter(Boolean).join(` `));
// Said only when the two readings differ: on everything else the hover would repeat the number under it. While a
// count is provisional the hover is what makes it one, so it is offered as soon as there is a number to qualify;
// a row with nothing to count (a rename, a conflict) draws no badge at all and gets no hover either.
const hint = computed<string | undefined>(() => {
    if (provisional.value) {
        return full.value === `` ? undefined : `${full.value} counting comments, still working out how much of it is code`;
    }
    if (!stripped.value || code === undefined || (code.additions === (additions ?? 0) && code.deletions === (deletions ?? 0))) {
        return undefined;
    }
    return commentsOnly.value ? `Only comments changed, ${full.value} of them` : `Code only · ${full.value} counting comments`;
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
    <!-- Half weight, not a spinner and not a placeholder: a review is a list of these, and a column of pending
         marks is a panel with no numbers on it. The count is git's, it may still be replaced by the code's, and
         both of those facts are what the dimming and the hover are for. -->
    <span v-else-if="hint !== undefined" class="inline-flex shrink-0" :class="provisional ? 'opacity-50' : ''" v-tooltip.top="hint">
        <DiffStat :additions="shown.additions" :deletions="shown.deletions" />
    </span>
    <DiffStat v-else :additions="shown.additions" :deletions="shown.deletions" />
</template>
