<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import Explainer from "./Explainer.vue";
import { AREA_GOOD, LANE, SEGMENT } from "./atoms";

// Token savings, drawn: one request as a stacked bar of what it carries, then the same bar under each switch. On
// demand shrinks the tool descriptions; stable instructions turn the instructions into a cache read; trimming after a
// pause clears old tool output from a conversation whose cache expired. Widths are a sketch, not a measurement.

const t = useT();

type Part = `instructions` | `tools` | `history` | `message`;
interface Segment {
    readonly part: Part;
    readonly width: number;
    /** How the switch changed this part, if it did: cached (cheap to read again) or cleared. */
    readonly effect?: `cached` | `cleared` | `shrunk`;
}

const FILL = {
    instructions: `bg-primary-tint text-content`,
    tools: `bg-info-tint text-content`,
    history: `bg-line-strong text-content`,
    message: `bg-content/40 text-content`,
} as const satisfies Record<Part, string>;
// A changed part wears its change instead of its part's fill: cached in the tone of a saving, cleared as an outline.
const EFFECT = {
    cached: AREA_GOOD,
    cleared: `border border-dashed border-line-strong text-subtle`,
    shrunk: undefined,
} as const;
const fillOf = (segment: Segment): string => (segment.effect === undefined ? undefined : EFFECT[segment.effect]) ?? FILL[segment.part];

const BASE: readonly Segment[] = [
    { part: `instructions`, width: 22 },
    { part: `tools`, width: 26 },
    { part: `history`, width: 40 },
    { part: `message`, width: 12 },
];
const ROWS = computed(
    () =>
        [
            { key: `every`, label: t(`sandbox.explainers.tokenSavings.everyRequest`), segments: BASE },
            {
                key: `onDemand`,
                label: t(`sandbox.agentToolLoading.onDemand`),
                segments: [
                    { part: `instructions`, width: 22 },
                    { part: `tools`, width: 5, effect: `shrunk` },
                    { part: `history`, width: 40 },
                    { part: `message`, width: 12 },
                ],
            },
            {
                key: `stable`,
                label: t(`sandbox.agentToolLoading.stable`),
                segments: [{ part: `instructions`, width: 22, effect: `cached` }, ...BASE.slice(1)],
            },
            {
                key: `coldTrim`,
                label: t(`sandbox.agentToolLoading.coldTrim`),
                segments: [
                    { part: `instructions`, width: 22 },
                    { part: `tools`, width: 26 },
                    { part: `history`, width: 14 },
                    { part: `history`, width: 26, effect: `cleared` },
                    { part: `message`, width: 12 },
                ],
            },
        ] satisfies { key: string; label: string; segments: readonly Segment[] }[],
);

const LEGEND: readonly Part[] = [`instructions`, `tools`, `history`, `message`];
</script>

<template>
    <Explainer
        :label="t(`sandbox.explainers.tokenSavings.label`)"
        :title="t(`sandbox.explainers.tokenSavings.title`)"
        :experience="t(`sandbox.explainers.tokenSavings.experience`)"
        :tokens="t(`sandbox.explainers.tokenSavings.tokens`)"
    >
        <div class="flex flex-wrap gap-x-3 gap-y-1 text-[0.625rem] text-subtle">
            <span v-for="part in LEGEND" :key="part" class="inline-flex items-center gap-1">
                <span class="h-2 w-3 rounded-sm" :class="FILL[part]" />{{ t(`sandbox.explainers.tokenSavings.part.${part}`) }}
            </span>
        </div>
        <div v-for="row in ROWS" :key="row.key" class="flex flex-col gap-1">
            <span :class="LANE">{{ row.label }}</span>
            <div class="flex gap-0.5">
                <span
                    v-for="(segment, index) in row.segments"
                    :key="index"
                    :class="[SEGMENT, fillOf(segment)]"
                    :style="{ width: `${segment.width}%` }"
                    >{{
                        segment.effect === `cached` || segment.effect === `cleared` ? t(`sandbox.explainers.tokenSavings.${segment.effect}`) : ``
                    }}</span
                >
            </div>
        </div>
    </Explainer>
</template>
