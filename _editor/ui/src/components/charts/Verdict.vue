<!--
    One measured answer in three ranks: verdict, what qualifies it, then the evidence it was measured over. Draws no container and no margin; the
    caller positions and frames it. Second readings use `xs`, not `sm` (see VERDICT_RANKS).
-->
<script setup lang="ts">
import { VERDICT_RANKS, VERDICT_TONES, type VerdictSize, type VerdictTone } from "./verdict.js";

const { size = `sm` } = defineProps<{
    /** The answer, already worded: "↓12%", "25%", "No effect", "Measuring", "Off". A WORD when there is no
     *  figure — the state IS the answer, and it belongs where the eye already is rather than four lines down. */
    value: string;
    /** What the value is a figure of. Never optional: "↓12%" alone does not say twelve percent of what. */
    unit: string;
    tone: VerdictTone;
    /** What qualifies the answer: the confidence interval, how much sample is still owed. Empty reads as absent,
     *  so a caller can pass a field that is sometimes blank without writing the guard. */
    detail?: string;
    /** What it was measured OVER — the two arms' sizes, the window. A figure with no account of how much data is
     *  behind it is one a reader cannot weigh. */
    evidence?: string;
    /** The surface's rank, not the number's importance. See VERDICT_RANKS. */
    size?: VerdictSize;
}>();
</script>

<template>
    <div>
        <p class="flex flex-wrap items-baseline gap-y-0.5" :class="VERDICT_RANKS[size].gap">
            <span class="tabular-nums" :class="[VERDICT_RANKS[size].value, VERDICT_TONES[tone]]">{{ value }}</span>
            <span class="min-w-0 text-muted" :class="VERDICT_RANKS[size].unit">{{ unit }}</span>
        </p>
        <p v-if="detail !== undefined && detail !== ``" class="mt-1 text-2xs text-subtle">{{ detail }}</p>
        <p v-if="evidence !== undefined && evidence !== ``" class="mt-0.5 text-2xs tabular-nums text-subtle">{{ evidence }}</p>
    </div>
</template>
