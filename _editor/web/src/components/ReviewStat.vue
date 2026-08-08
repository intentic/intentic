<script setup lang="ts">
import { DiffStat } from "@intentic/ui";
import { computed } from "vue";
import { useLayout } from "../composables/useLayout";
import type { LineStat } from "../composables/workspace/codeStat";

/* A changed file's +/− IN THE READING THE SURFACE IS SHOWING — the review's rows and headings, and the bar over
 * the open diff. Every one of them renders this rather than DiffStat directly, because the choice it makes has
 * to be the same choice in all of them: a header that disagrees with the sum of its rows is worse than either
 * number on its own.
 *
 * With comments hidden (the default) the diff is computed on code alone, so the counts are too. Git's own are
 * one hover away and are what the change will land as — the two readings are never both on screen as bare
 * numbers, because two totals side by side is a question, not an answer.
 *
 * A change that is ENTIRELY comments would otherwise render as +0 −0, which is the badge's way of saying "a
 * rename" and reads as nothing happened. It says what it is instead, and stays in the list: something did change
 * here, and hiding the row would be the reader's decision to make, not this component's. */

const { code, additions, deletions } = defineProps<{
    // Code-only counts, once the file has been read and stripped. Undefined until then, and for good on a file
    // with no grammar — whose pane shows every line it has, making git's numbers the honest ones.
    code?: LineStat;
    // Git's own, comments included.
    additions?: number;
    deletions?: number;
}>();

const { showComments } = useLayout();

const stripped = computed(() => !showComments.value && code !== undefined);
const shown = computed(() => (stripped.value ? code! : { additions, deletions }));
const commentsOnly = computed(
    () => stripped.value && code!.additions === 0 && code!.deletions === 0 && ((additions ?? 0) > 0 || (deletions ?? 0) > 0),
);

// Git's reading, spelled the way the badge spells it, for the hover.
const full = computed(() => [additions ? `+${additions}` : ``, deletions ? `−${deletions}` : ``].filter(Boolean).join(` `));
// Said only when the two readings differ — on everything else the hover would repeat the number under it.
const hint = computed<string | undefined>(() => {
    if (!stripped.value || (code!.additions === (additions ?? 0) && code!.deletions === (deletions ?? 0))) {
        return undefined;
    }
    return commentsOnly.value ? `Only comments changed — ${full.value} of them` : `Code only · ${full.value} counting comments`;
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
    <span v-else-if="hint !== undefined" class="inline-flex shrink-0" v-tooltip.top="hint">
        <DiffStat :additions="shown.additions" :deletions="shown.deletions" />
    </span>
    <DiffStat v-else :additions="shown.additions" :deletions="shown.deletions" />
</template>
