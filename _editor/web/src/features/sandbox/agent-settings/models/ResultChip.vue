<script setup lang="ts">
import { type Tip, toneWash } from "@intentic/ui";
import { formatCount } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { type ResultTable, headlineOf } from "./experimentReadings";

// A measured setting's Simple view: its one finding as a chip under the switch ("45% fewer listed directories"), the
// comparison it stands on a hover away. The comparison group keeps running underneath and is not mentioned: whoever
// wants to change it opens Advanced, where MeasurementPanel shows the whole table. Nothing at all while there is no
// table, so a section with nothing measured yet reads as plain switches rather than as a promise.

const t = useT();
const { table } = defineProps<{ table: ResultTable | undefined }>();

const headline = computed(() => headlineOf(table));

const CHIP = `inline-flex items-baseline gap-1 rounded-sm px-1.5 py-px text-xs font-medium tabular-nums`;

const view = computed<{ text: string; mark: string; tip: Tip | undefined } | undefined>(() => {
    const found = headline.value;
    if (found === undefined) {
        return undefined;
    }
    const { outcome, key } = found.row;
    const compared = t(`sandbox.resultChip.comparedOver`, { on: formatCount(found.on), off: formatCount(found.off) });
    if (outcome.kind === `unclear`) {
        return { text: t(`sandbox.resultChip.noDifference`), mark: `text-xs text-subtle`, tip: { title: compared } };
    }
    if (outcome.kind === `early`) {
        const progress =
            outcome.have === undefined || outcome.need === undefined
                ? t(`sandbox.resultChip.measuring`)
                : t(`sandbox.resultChip.measuringProgress`, { have: formatCount(outcome.have), need: outcome.need });
        return { text: progress, mark: `text-xs text-subtle`, tip: undefined };
    }
    const range = { low: outcome.low, high: outcome.high };
    return {
        text: `${outcome.kind === `lower` ? `↓` : `↑`} ${t(`sandbox.resultChip.${outcome.kind}.${key}`, { pct: outcome.pct })}`,
        mark: toneWash(outcome.kind === `lower` ? `success` : `warning`, CHIP),
        tip: {
            title:
                outcome.low === undefined || outcome.high === undefined
                    ? compared
                    : t(`sandbox.measurementPanel.${outcome.kind === `lower` ? `likelyFewer` : `likelyMore`}`, range),
            note: outcome.low === undefined ? undefined : compared,
        },
    };
});
</script>

<template>
    <span
        v-if="view !== undefined"
        v-tooltip.top="view.tip"
        :tabindex="view.tip === undefined ? undefined : 0"
        :class="[view.mark, view.tip === undefined ? `` : `cursor-help`]"
        data-result-chip
        >{{ view.text }}</span
    >
</template>
