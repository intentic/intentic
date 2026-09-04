<!-- HOW THIS AUTOMATION HAS BEEN GOING, as one glyph-width mark per run.

     The list's whole claim is that it can be read as a COLUMN OF STATES, and until this existed the column was
     one word wide: "ran 7h ago". That word says the last outcome and nothing about the shape behind it, so the
     two questions a standing job actually raises — is it flapping, and has it ever worked — were both one
     disclosure away, on every row, forever. A row that failed once after forty clean nights and a row that has
     failed every night since it was written rendered the identical red word.

     OLDEST LEFT, NEWEST RIGHT, which is the direction time is read in and the opposite of the order the ledger
     arrives in (newest first, see automations-store). Reversed here rather than at the caller because every
     caller would reverse it the same way and one of them would eventually not.

     A SKIP IS NOT A DENT. A guard that checked and found nothing is the DESIGNED outcome of a chore — it cost
     nothing and it is why the chore is cheap to leave on — so it draws as the quietest mark on the strip rather
     than as a gap in a run of green. Same argument the row's health dot makes about `idle`; an `interrupted`
     run is the sandbox going away under a wake, which is not the automation's failure either.

     NOT A SPARKLINE, and not a per-pip control. There is no quantity here to plot, only a sequence of verdicts,
     and a 3px-wide button is a target nobody can hit: the whole strip is one tooltip and the row it sits in
     opens onto the same runs as a list with real hit areas and links into each transcript. -->
<script setup lang="ts">
import type { AutomationRun } from "@intentic/sandbox-contract";
import { computed } from "vue";

const { runs, limit = 8 } = defineProps<{ runs: readonly AutomationRun[]; limit?: number }>();

/* The ledger keeps twenty (RUNS_KEPT) and the strip shows the last eight of them. Not all twenty: at a row's
 * height the marks have to stay ~3px apart to read as separate events, and twenty of those is 100px of the
 * trailing cluster — wider than the two time facts beside it, for history nobody scans that far back. Eight
 * covers "the last week of a nightly" and "this morning" on a chattier trigger. */
const shown = computed(() => runs.slice(0, limit).toReversed());

const MARK: Record<AutomationRun[`outcome`], string> = {
    completed: `bg-success/70`,
    error: `bg-danger`,
    // Checked, found nothing, cost nothing. Deliberately the same tone as the empty slot beside it.
    skipped: `bg-content/15`,
    interrupted: `bg-content/25`,
};

// The tooltip has to say what the marks cannot: which colour meant what, and how many of each. Ordered
// worst-first, because the reason anyone hovers this is a red mark.
const summary = computed<string>(() => {
    const count = (outcome: AutomationRun[`outcome`]): number => shown.value.filter((run) => run.outcome === outcome).length;
    const parts = [
        [count(`error`), `failed`],
        [count(`completed`), `ran`],
        [count(`skipped`), `skipped`],
        [count(`interrupted`), `cut off`],
    ] as const;
    const said = parts.filter(([total]) => total > 0).map(([total, verb]) => `${total} ${verb}`);
    return `Last ${shown.value.length === 1 ? `run` : `${shown.value.length} runs`}: ${said.join(`, `)}`;
});
</script>

<template>
    <!-- RIGHT-ALIGNED INSIDE A FIXED BOX, which is the caller's job and the reason this draws no width of its
         own: a strip sized by its run count puts every row's history at a different x, and a column that does
         not line up is a column nobody scans. The marks grow leftward from a fixed right edge, so the newest
         run — the one being looked for — is always in the same place.
         `items-center` on marks of one height rather than a stretch: this rides a two-line row, and a mark that
         grew with the row would read as a bar chart of nothing. -->
    <span v-if="shown.length > 0" class="flex items-center justify-end gap-0.5" v-tooltip.top="summary" :aria-label="summary">
        <span v-for="run in shown" :key="run.at" class="h-3 w-1 rounded-xs" :class="MARK[run.outcome]"></span>
    </span>
</template>
