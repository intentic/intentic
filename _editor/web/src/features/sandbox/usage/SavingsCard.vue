<script setup lang="ts">
import { Card, InfoHint, Verdict, type VerdictTone } from "@intentic/ui";

// One frame shared by all three savings cards, with four fixed slots:
//   TITLE: what is measured, with the method behind an info hint
//   VERDICT: the answer, same size and place on every card (a word like "Measuring" when there's no figure)
//   BODY: the evidence (bar, arms, or a toggle)
//   FOOTNOTE: provenance, bottom-aligned across the row
// The verdict slot is `<Verdict>`, owned by the design system, not this file.

defineProps<{
    title: string;
    value: string;
    unit: string;
    // Success is reserved for a saving that was actually measured: never for a card that is merely switched on.
    tone: VerdictTone;
}>();
</script>

<template>
    <!--
        `@container`: the body lays out against the card, not the viewport, which sit many nested widths apart (rail,
        chat panel, tab padding).
    -->
    <Card class="@container flex min-w-0 flex-col gap-3">
        <div class="flex items-start justify-between gap-2">
            <h3 class="text-sm font-semibold text-content">{{ title }}</h3>
            <InfoHint :label="`How ${title} is measured`" class="shrink-0">
                <span class="block text-xs text-content"><slot name="hint" /></span>
            </InfoHint>
        </div>

        <!-- Unit is not decoration: "down 12%" alone doesn't say of what, and the two experiments use different metrics. -->
        <Verdict size="lg" :value="value" :unit="unit" :tone="tone" />

        <slot />

        <p v-if="$slots[`footnote`]" class="mt-auto pt-1 text-2xs text-subtle"><slot name="footnote" /></p>
    </Card>
</template>
