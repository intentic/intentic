<script setup lang="ts">
import { Icon, type IconName, InfoHint } from "@intentic/ui";
import { ARROW, AREA_GOOD, LANE } from "./explainerAtoms";

// The (i) a settings section keeps its details behind, so the page itself says one line. Inside, the details are
// glanced at, not read: a headline, an optional picture of how the thing travels (`steps`, tiles joined by arrows,
// the last one usually the outcome), then a column of facts, each an icon and a few words. A fact may lead with a term
// in the headline's ink, for a legend ("Read-only …"). Drawn with explainerAtoms, as every explainer card is.

export interface HintStep {
    readonly icon: IconName;
    readonly label: string;
    /** The outcome a reader wants, tinted as one. */
    readonly good?: boolean;
    /** A command or a path, which no language translates: set in the mono face. */
    readonly code?: boolean;
}

export interface HintFact {
    readonly icon: IconName;
    readonly text: string;
    /** A word or two set before the text in the headline's ink: the name the fact explains. */
    readonly term?: string | undefined;
}

const {
    label,
    title,
    lane,
    steps = [],
    facts = [],
} = defineProps<{
    /** The (i)'s accessible name: "About API tokens". */
    label: string;
    title: string;
    /** Names what the steps follow: "Each sandbox its agent makes". */
    lane?: string;
    steps?: readonly HintStep[];
    facts?: readonly HintFact[];
}>();

const TILE = `flex min-w-0 flex-1 flex-col items-center gap-1 rounded-md border px-1 py-1.5 text-center text-2xs leading-tight`;
</script>

<template>
    <!-- Always the wide card: a column of facts and a row of tiles want the room a sentence does not. -->
    <InfoHint :label wide>
        <span class="flex flex-col gap-3 text-xs">
            <span class="font-medium text-content">{{ title }}</span>
            <!-- The steps on a ground of their own, so their tiles read as one figure rather than as more of the card. -->
            <span v-if="steps.length > 0" class="flex flex-col gap-2 rounded-lg border border-line-subtle bg-canvas/60 p-3">
                <span v-if="lane" :class="LANE">{{ lane }}</span>
                <span class="flex items-stretch gap-1">
                    <template v-for="(step, index) in steps" :key="step.label">
                        <Icon v-if="index > 0" name="arrow-right" class="self-center" :class="ARROW" aria-hidden="true" />
                        <span :class="[TILE, step.good ? AREA_GOOD : `border-line bg-card text-content`]">
                            <Icon :name="step.icon" class="text-sm" :class="step.good ? `` : `text-subtle`" aria-hidden="true" />
                            <span :class="step.code ? `font-mono` : ``">{{ step.label }}</span>
                        </span>
                    </template>
                </span>
            </span>
            <span v-if="facts.length > 0" class="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-2 gap-y-1.5">
                <template v-for="fact in facts" :key="fact.text">
                    <Icon :name="fact.icon" class="text-subtle" aria-hidden="true" />
                    <span class="text-muted"
                        ><span v-if="fact.term" class="me-1 font-medium text-content">{{ fact.term }}</span
                        >{{ fact.text }}</span
                    >
                </template>
            </span>
        </span>
    </InfoHint>
</template>
