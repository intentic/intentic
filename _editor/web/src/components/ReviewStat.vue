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
 * A NUMBER THAT IS NOT KNOWN YET IS NOT PRINTED. That is the rule this component exists to keep, and it used to
 * break it: a row whose file had not been read had no code-only count, so it printed git's — and the moment the
 * file WAS read, which is what clicking it does, the number changed under the reader, along with its heading and
 * the panel's total. Being told +54 while scanning and +12 after clicking teaches you to trust neither. So an
 * unknown count now renders as a pending mark that says exactly that, with git's reading on the hover; the
 * background reader (prefetch/sources/agentsWarm) is what makes the state rare, by having read the review's rows
 * before its reader arrives. A file with NOTHING TO STRIP — no grammar, bytes, too big to send — is a different
 * answer and prints git's numbers for good: they are what its pane shows, line for line.
 *
 * A change that is ENTIRELY comments would otherwise render as +0 −0, which is the badge's way of saying "a
 * rename" and reads as nothing happened. It says what it is instead, and stays in the list: something did change
 * here, and hiding the row would be the reader's decision to make, not this component's. */

const { code, counting, additions, deletions } = defineProps<{
    // Code-only counts, once the file has been read and stripped. Absent when the file has no grammar to strip —
    // whose pane shows every line it has, making git's numbers the honest ones.
    code?: LineStat;
    // True while the reading is still being worked out — the file has not been read, so no count can be stated.
    // A total is `counting` when ANY row under it is (see sumCounts): part of a sum is not a sum.
    counting?: boolean;
    // Git's own, comments included.
    additions?: number;
    deletions?: number;
}>();

const { showComments } = useLayout();

// Whether the surface is showing code alone — the only mode in which any of the above matters.
const stripped = computed(() => !showComments.value);
const pending = computed(() => stripped.value && counting === true);
const shown = computed(() => (stripped.value && code !== undefined ? code : { additions, deletions }));
const commentsOnly = computed(
    () => stripped.value && !pending.value && code?.additions === 0 && code.deletions === 0 && ((additions ?? 0) > 0 || (deletions ?? 0) > 0),
);

// Git's reading, spelled the way the badge spells it, for the hover.
const full = computed(() => [additions ? `+${additions}` : ``, deletions ? `−${deletions}` : ``].filter(Boolean).join(` `));
// Said only when the two readings differ — on everything else the hover would repeat the number under it. While a
// count is pending it is the only number there is, which is exactly when the hover is worth having.
const hint = computed<string | undefined>(() => {
    if (pending.value) {
        return full.value === `` ? `Working out how much of this is code` : `Working out how much of this is code — ${full.value} counting comments`;
    }
    if (!stripped.value || code === undefined || (code.additions === (additions ?? 0) && code.deletions === (deletions ?? 0))) {
        return undefined;
    }
    return commentsOnly.value ? `Only comments changed — ${full.value} of them` : `Code only · ${full.value} counting comments`;
});
</script>

<template>
    <!-- Not a spinner: a review is a list of these, and forty spinning glyphs down one column is a screen that
         looks broken. Three dots in the badge's own font and size hold its place and read as "not yet". -->
    <span v-if="pending" class="shrink-0 font-mono text-[0.65rem] text-subtle" v-tooltip.top="hint">…</span>
    <span
        v-else-if="commentsOnly"
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
