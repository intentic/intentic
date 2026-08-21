<script setup lang="ts">
import { computed } from "vue";
import type { Composition } from "./savingsChart";
import { formatCompact } from "./usageChart";

/* Where a window's raw shell output went, as ONE stacked bar plus the list that names its parts.
 *
 * A stack rather than ranked bars, because this is a budget that must add up: the segment nobody thinks to
 * draw (what actually reached the assistant) is the whole point of the chart, and a ranked list of savings
 * hides it. The attribution behind the segments is sequential (each mechanism weighed against what reached it),
 * which is exactly what makes the parts sum to the whole and lets them be stacked at all.
 *
 * The list under it is the legend, so identity never rests on colour-matching, and it is where the numbers
 * live: a 2% segment is unreadable as a mark and perfectly readable as a row.
 *
 * The legend carries ONE number per row. It used to carry two: tokens and a rounded share, and on real data
 * the share column read "24% 0% 0% 0% 0% 0%", six rows of ink saying nothing while the labels it was stealing
 * space from truncated to "collapse rep…" and "directory listi…". The share is already drawn (that is what the
 * bar is), stated at both ends of it, and exact on hover; the label is the thing that cannot be recovered from
 * anywhere else, so the label gets the room. */

const { composition } = defineProps<{ composition: Composition }>();

// Against the raw total, which the segments sum to by construction. Zero data still yields a positive divisor
// so an empty window draws an empty track rather than dividing by nothing.
const share = (tokens: number): number => (composition.rawTokens === 0 ? 0 : (tokens / composition.rawTokens) * 100);

const reached = computed(() => composition.segments.find((segment) => segment.kind === `reached`));
// Split so the residual can sit under a rule: "these mechanisms removed" and "this is what was left" are two
// claims, and running them together as seven identical rows was what made the last one look like a sixth
// cleaner. Order is preserved: compositionOf already ranks the saved segments and appends the residual.
const removed = computed(() => composition.segments.filter((segment) => segment.kind === `saved`));

const tooltipFor = (label: string, tokens: number): string => `${label} · ~${formatCompact(tokens)} tokens · ${Math.round(share(tokens))}% of raw`;
</script>

<template>
    <figure class="flex min-w-0 flex-col gap-2">
        <div class="flex h-2.5 w-full overflow-hidden rounded-full bg-canvas">
            <!-- min-w-px so a mechanism that saved a little is still visibly present rather than absent:
                 those two states mean different things and this is the only place they could be confused. -->
            <div
                v-for="segment in composition.segments"
                :key="segment.key"
                v-tooltip.top="tooltipFor(segment.label, segment.tokens)"
                class="h-full min-w-px cursor-default"
                :style="{ width: `${share(segment.tokens)}%`, background: segment.color }"
            />
        </div>

        <!-- Only the ends are labelled: the two numbers the bar is a claim about. The arrow rides the right-hand
             label rather than sitting between them, where `justify-between` would strand it mid-card and it
             would read as a third thing rather than as the sentence's verb. -->
        <div class="flex items-baseline justify-between gap-2 text-2xs tabular-nums text-subtle">
            <span>~{{ formatCompact(composition.rawTokens) }} raw</span>
            <span><span aria-hidden="true">→ </span>~{{ formatCompact(reached?.tokens ?? 0) }} reached the assistant</span>
        </div>

        <figcaption class="sr-only">Raw shell output by what removed it, and what was left for the assistant.</figcaption>
        <ul class="mt-1 flex flex-col gap-1.5">
            <li v-for="segment in removed" :key="segment.key" class="flex min-w-0 items-baseline gap-2">
                <span class="size-2 shrink-0 translate-y-px rounded-[2px]" :style="{ background: segment.color }" />
                <span class="min-w-0 flex-1 text-xs text-content">{{ segment.label }}</span>
                <span class="shrink-0 text-2xs tabular-nums text-muted">~{{ formatCompact(segment.tokens) }}</span>
            </li>
            <li v-if="reached !== undefined" class="mt-0.5 flex min-w-0 items-baseline gap-2 border-t border-line pt-2">
                <span class="size-2 shrink-0 translate-y-px rounded-[2px]" :style="{ background: reached.color }" />
                <span class="min-w-0 flex-1 text-xs text-muted">{{ reached.label }}</span>
                <span class="shrink-0 text-2xs tabular-nums text-muted">~{{ formatCompact(reached.tokens) }}</span>
            </li>
        </ul>

        <!-- The cost that lives inside the emitted total, said out loud. It is what makes the trimming
             reversible (`retrieve-output`), and a savings chart that quietly netted it off would be
             overstating itself by exactly this much. Why it is worth paying is in the card's hint; that it is
             being paid stays on the card, because that is the part a reader is owed without hovering. -->
        <p v-if="composition.footerTokens > 0" class="text-2xs text-subtle">
            Includes ~{{ formatCompact(composition.footerTokens) }} tokens of retrieval footers added back.
        </p>
    </figure>
</template>
