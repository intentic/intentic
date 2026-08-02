<script setup lang="ts">
import { Card, InfoHint } from "@intentic/ui";

/* ONE savings card's frame — and the same frame for all three, which is the whole point of it existing.
 *
 * The three mechanisms this section reports on measure different things in different units and two of them are
 * experiments, so the cards used to be written independently and drifted into three layouts: one led with a
 * percentage, the other two led with a methodology tag ("terse steer · A/B") and opened with a paragraph. A
 * reader could not scan the row, because there was no slot that held the answer on every card.
 *
 * So the frame fixes four positions, and a card may only fill them:
 *
 *   TITLE (i)   what is being measured, one line, with the method behind the hint
 *   VERDICT     the answer, at the same size and in the same place on every card — "25%", "↓12%", "Measuring",
 *               "Off". A word when there is no figure: the state IS the answer, and it belongs where the eye
 *               already is rather than four lines down in 11px prose.
 *   BODY        the evidence — the bar, the arms, or what to switch on.
 *   FOOTNOTE    provenance. Bottom-aligned so the row's footnotes share a baseline whatever the bodies do.
 *
 * The method text moves into the hint rather than being deleted: it is right, it is what makes the numbers
 * trustworthy, and it is not what anyone is reading the card FOR. Hover/focus is the correct altitude for it. */

const { title, value, unit, tone } = defineProps<{
    title: string;
    value: string;
    unit: string;
    // Success is reserved for a saving that was actually measured — never for a card that is merely switched on.
    tone: "success" | "content" | "muted";
}>();

const VALUE_TONE = { success: `text-success`, content: `text-content`, muted: `text-muted` };
</script>

<template>
    <!-- @container, so the body can lay itself out against the CARD rather than the viewport. At this depth the
         two have nothing to do with each other: the rail, the chat panel and the tab's own padding sit between
         them, which is how a "3 columns at xl" grid came to draw 215px cards on a 1280px screen. -->
    <Card class="@container flex min-w-0 flex-col gap-3">
        <div class="flex items-start justify-between gap-2">
            <h3 class="text-sm font-semibold text-content">{{ title }}</h3>
            <InfoHint :label="`How ${title} is measured`" class="shrink-0">
                <span class="block text-xs text-content"><slot name="hint" /></span>
            </InfoHint>
        </div>

        <!-- Verdict and unit on one baseline. The unit is not decoration — "↓12%" alone does not say twelve
             percent of what, and the two experiments are scored on different metrics. -->
        <div class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span class="text-2xl leading-none font-semibold tabular-nums" :class="VALUE_TONE[tone]">{{ value }}</span>
            <span class="min-w-0 text-xs text-muted">{{ unit }}</span>
        </div>

        <slot />

        <p v-if="$slots[`footnote`]" class="mt-auto pt-1 text-2xs text-subtle"><slot name="footnote" /></p>
    </Card>
</template>
