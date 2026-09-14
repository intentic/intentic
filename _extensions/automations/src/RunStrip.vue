<!-- One glyph-width mark per automation run, oldest left to newest right — reversed from the ledger's newest-first order. -->
<script setup lang="ts">
import type { AutomationRun } from "@intentic/sandbox-contract";
import { computed } from "vue";

const { runs, limit = 8 } = defineProps<{ runs: readonly AutomationRun[]; limit?: number }>();

/* The ledger keeps twenty (RUNS_KEPT) and the strip shows the last eight of them. */
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
<!-- RIGHT-ALIGNED INSIDE A FIXED BOX, which is the caller's job and the reason this draws no width of its own. -->
    <span v-if="shown.length > 0" class="flex items-center justify-end gap-0.5" v-tooltip.top="summary" :aria-label="summary">
        <span v-for="run in shown" :key="run.at" class="h-3 w-1 rounded-xs" :class="MARK[run.outcome]"></span>
    </span>
</template>
