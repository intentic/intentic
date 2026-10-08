<!-- One glyph-width mark per automation run, oldest left to newest right — reversed from the ledger's newest-first order. -->
<script setup lang="ts">
import type { AutomationRun } from "@intentic/sandbox-contract";
import { toneDot } from "@intentic/extension-ui";
import { computed } from "vue";
import { t } from "./i18n.js";

const { runs, limit = 8 } = defineProps<{ runs: readonly AutomationRun[]; limit?: number }>();

/* The ledger keeps twenty (RUNS_KEPT) and the strip shows the last eight of them. */
const shown = computed(() => runs.slice(0, limit).toReversed());

const MARK: Record<AutomationRun[`outcome`], string> = {
    completed: toneDot(`success`),
    error: toneDot(`danger`),
    // Checked, found nothing, cost nothing. Deliberately the same tone as the empty slot beside it.
    skipped: `bg-content/15`,
    interrupted: `bg-content/25`,
};

// The hover card has to say what the marks cannot: which colour meant what, and how many of each. Ordered
// worst-first, because the reason anyone hovers this is a failed run; an outcome with no runs is left out.
type Tone = "success" | "danger";
const summary = computed<{ title: string; rows: { label: string; value: number | string; tone?: Tone }[] }>(() => {
    const count = (outcome: AutomationRun[`outcome`]): number | string => shown.value.filter((run) => run.outcome === outcome).length || ``;
    return {
        title: t(`runStrip.lastRuns`, { count: shown.value.length }, shown.value.length),
        rows: [
            { label: t(`runStrip.failed`), value: count(`error`), tone: `danger` },
            { label: t(`runStrip.ran`), value: count(`completed`), tone: `success` },
            { label: t(`runStrip.skipped`), value: count(`skipped`) },
            { label: t(`runStrip.cutOff`), value: count(`interrupted`) },
        ],
    };
});
// The same facts, read out as one line.
const spoken = computed<string>(() => {
    const said = summary.value.rows.filter((row) => row.value !== ``).map((row) => `${row.value} ${row.label}`);
    return `${summary.value.title}: ${said.join(`, `)}`;
});
</script>

<template>
<!-- RIGHT-ALIGNED INSIDE A FIXED BOX, which is the caller's job and the reason this draws no width of its own. -->
    <span v-if="shown.length > 0" class="flex items-center justify-end gap-0.5" v-tooltip.top="summary" :aria-label="spoken">
        <span v-for="run in shown" :key="run.at" class="h-3 w-1 rounded-xs" :class="MARK[run.outcome]"></span>
    </span>
</template>
