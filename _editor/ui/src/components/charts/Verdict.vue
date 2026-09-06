<!-- ONE MEASURED ANSWER, IN THREE RANKS: the figure, the unit it is a figure OF, what qualifies it, and what it
     was measured over. The app reports the same A/B experiments in two places — the Usage tab's savings cards and
     the agent settings' rows — and before this it reported them in two visual languages, so a reader crossing the
     two tabs could not tell they were reading one report.

     THE ORDER IS THE POINT, AND IT IS <SavingsCard>'S: verdict, then what qualifies it, then the evidence. The
     settings rows used to glue all four facts into one em-dash sentence at one size, and four facts at one rank
     read as none — the row carrying the most information on the page was the one nobody could read.

     IT DRAWS NO CONTAINER, DELIBERATELY, and that is the other half of what went wrong. The settings copy wrapped
     itself in a `rounded-lg bg-canvas` well inside a <Row>'s `#below`, which is the one thing that slot documents
     itself as existing to prevent ("so it stays inside the row's hairline boundary instead of spawning its own
     boxed inset") and the failure <DisclosureRow> writes up at length: a fill under a row's header splits the row
     down a colour change, and the lower half reads as belonging to the page rather than to the name above it. A
     figure has no opinion about the surface it is on. Where this sits, and what it sits in, is the caller's.

     NOR ANY MARGIN. The caller's `flex flex-col gap-*` positions it, so it is correct in a card, in a row's
     `#below` and in a stack of two without a call site subtracting anything.

     SECOND READINGS ARE `xs`, NOT ANOTHER `sm`. See VERDICT_RANKS. -->
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
