<script setup lang="ts">
import { computed } from "vue";
import type { Composition } from "./savingsChart";
import { formatCompact } from "./usageChart";

// Where a window's raw shell output went: one stacked bar (segments sum to the whole, including what reached the
// assistant) plus a legend list where the numbers actually live. Legend carries one number, tokens; the share is
// already the bar itself, and the label gets the room a second column would cost it.

const { composition } = defineProps<{ composition: Composition }>();

// Share of raw total; zero data yields a positive divisor so an empty window draws an empty track.
const share = (tokens: number): number => (composition.rawTokens === 0 ? 0 : (tokens / composition.rawTokens) * 100);

const reached = computed(() => composition.segments.find((segment) => segment.kind === `reached`));
// Split from the residual so "removed" and "left" read as two claims; order is preserved from compositionOf.
const removed = computed(() => composition.segments.filter((segment) => segment.kind === `saved`));

const tooltipFor = (label: string, tokens: number): string => `${label} · ~${formatCompact(tokens)} tokens · ${Math.round(share(tokens))}% of raw`;
</script>

<template>
    <figure class="flex min-w-0 flex-col gap-2">
        <div class="flex h-2.5 w-full overflow-hidden rounded-full bg-canvas">
            <!-- `min-w-px`: a small saving stays visible, not absent; the one place those two could be confused. -->
            <div
                v-for="segment in composition.segments"
                :key="segment.key"
                v-tooltip.top="tooltipFor(segment.label, segment.tokens)"
                class="h-full min-w-px cursor-default"
                :style="{ width: `${share(segment.tokens)}%`, background: segment.color }"
            />
        </div>

        <!--
            Only the ends are labelled, the two numbers the bar claims. The arrow rides the right label rather than
            sitting mid-card as a third thing.
        -->
        <div class="flex items-baseline justify-between gap-2 text-2xs tabular-nums text-subtle">
            <span>~{{ formatCompact(composition.rawTokens) }} raw</span>
            <span><span aria-hidden="true">→ </span>~{{ formatCompact(reached?.tokens ?? 0) }} reached the assistant</span>
        </div>

        <figcaption class="sr-only">Raw shell output by what removed it, and what was left for the assistant.</figcaption>
        <ul class="mt-1 flex flex-col gap-1.5">
            <li v-for="segment in removed" :key="segment.key" class="flex min-w-0 items-baseline gap-2">
                <span class="size-2 shrink-0 translate-y-px rounded-2xs" :style="{ background: segment.color }" />
                <span class="min-w-0 flex-1 text-xs text-content">{{ segment.label }}</span>
                <span class="shrink-0 text-2xs tabular-nums text-muted">~{{ formatCompact(segment.tokens) }}</span>
            </li>
            <li v-if="reached !== undefined" class="mt-1.5 flex min-w-0 items-baseline gap-2">
                <span class="size-2 shrink-0 translate-y-px rounded-2xs" :style="{ background: reached.color }" />
                <span class="min-w-0 flex-1 text-xs text-muted">{{ reached.label }}</span>
                <span class="shrink-0 text-2xs tabular-nums text-muted">~{{ formatCompact(reached.tokens) }}</span>
            </li>
        </ul>

        <!--
            Cost already inside the emitted total, said out loud (it's what makes trimming reversible via
            `retrieve-output`); netting it off silently would overstate the saving. Why it's worth paying is in the hint; that it's paid stays on the
            card.
        -->
        <p v-if="composition.footerTokens > 0" class="text-2xs text-subtle">
            Includes ~{{ formatCompact(composition.footerTokens) }} tokens of retrieval footers added back.
        </p>
    </figure>
</template>
