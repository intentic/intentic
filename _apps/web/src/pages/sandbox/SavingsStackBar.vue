<script setup lang="ts">
import { computed } from "vue";
import type { Composition } from "./savingsChart";
import { formatCompact } from "./usageChart";

/* Where a window's raw shell output went, as ONE stacked bar plus the list that names its parts.
 *
 * A stack rather than ranked bars, because this is a budget that must add up: the segment nobody thinks to
 * draw — what actually reached the assistant — is the whole point of the chart, and a ranked list of savings
 * hides it. The attribution behind the segments is sequential (each mechanism weighed against what reached it),
 * which is exactly what makes the parts sum to the whole and lets them be stacked at all.
 *
 * The list under it is the legend, so identity never rests on colour-matching, and it is where the numbers
 * live: a 2% segment is unreadable as a mark and perfectly readable as a row. */

const { composition } = defineProps<{ composition: Composition }>();

// Against the raw total, which the segments sum to by construction. Zero data still yields a positive divisor
// so an empty window draws an empty track rather than dividing by nothing.
const share = (tokens: number): number => (composition.rawTokens === 0 ? 0 : (tokens / composition.rawTokens) * 100);

const reached = computed(() => composition.segments.find((segment) => segment.kind === `reached`));

const tooltipFor = (label: string, tokens: number): string => `${label} · ~${formatCompact(tokens)} tokens · ${Math.round(share(tokens))}% of raw`;
</script>

<template>
    <figure class="flex flex-col gap-2.5">
        <div class="flex h-3 w-full overflow-hidden rounded-[4px] bg-canvas">
            <!-- min-w-px so a mechanism that saved a little is still visibly present rather than absent —
                 those two states mean different things and this is the only place they could be confused. -->
            <div
                v-for="segment in composition.segments"
                :key="segment.key"
                v-tooltip.top="tooltipFor(segment.label, segment.tokens)"
                class="h-full min-w-px cursor-default"
                :style="{ width: `${share(segment.tokens)}%`, background: segment.color }"
            />
        </div>

        <!-- Only the ends are labelled: the two numbers the bar is a claim about. -->
        <div class="flex justify-between text-2xs tabular-nums text-subtle">
            <span>~{{ formatCompact(composition.rawTokens) }} raw</span>
            <span>~{{ formatCompact(reached?.tokens ?? 0) }} reached the assistant</span>
        </div>

        <figcaption class="sr-only">Raw shell output by what removed it, and what was left for the assistant.</figcaption>
        <ul class="flex flex-col gap-1.5">
            <li v-for="segment in composition.segments" :key="segment.key" class="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-2">
                <span class="size-2 shrink-0 rounded-[2px]" :style="{ background: segment.color }" />
                <span class="truncate text-xs" :class="segment.kind === `reached` ? `text-muted italic` : `text-content`">{{ segment.label }}</span>
                <span class="justify-self-end text-2xs tabular-nums text-muted">~{{ formatCompact(segment.tokens) }}</span>
                <span class="w-9 justify-self-end text-2xs tabular-nums text-subtle">{{ Math.round(share(segment.tokens)) }}%</span>
            </li>
        </ul>

        <!-- The cost that lives inside the emitted total, said out loud. It is what makes the trimming
             reversible (`retrieve-output`), and a savings chart that quietly netted it off would be
             overstating itself by exactly this much. -->
        <p v-if="composition.footerTokens > 0" class="text-2xs text-subtle">
            Includes ~{{ formatCompact(composition.footerTokens) }} tokens of retrieval footers — the pointers that let the agent grep back the full
            output.
        </p>
    </figure>
</template>
