<script lang="ts">
import type { ExperimentVerdict } from "../../usage/savingsChart";

// Plain <script> block only to export this type; `<script setup>` can't carry an export.
export interface PanelReading {
    readonly verdict: ExperimentVerdict;
    // Sample sizes for the two arms; carried here since this row has no chart to carry them.
    readonly on: number;
    readonly off: number;
}
</script>

<script setup lang="ts">
import { Row, ui, Verdict } from "@intentic/ui";
import { commitPercent } from "./numberInputs";

// Shared "measure it" block for the two settings with an experiment (iq search teaching, output cleaners), built from
// `<Row>`/`<Verdict>` primitives rather than hand-drawn markup. Shows one headline reading (the experiment's first
// metric) plus secondary readings below it; methodology belongs in the group's info dialog, not here.

const {
    percent,
    readings,
    note,
    onLabel,
    offLabel,
    disabled = false,
} = defineProps<{
    /** Holdout percent (0-100). */
    percent: number;
    /** First entry is the headline; empty until the daemon has an experiment to report. */
    readings: readonly PanelReading[];
    /** One line describing what the box does; longer explanation belongs in the group's info dialog. */
    note: string;
    /** Arm labels in the reader's words, e.g. "taught" / "cold". */
    onLabel: string;
    offLabel: string;
    disabled?: boolean;
}>();

const emit = defineEmits<{ commit: [fraction: number] }>();

// Formatted here, not in the template: `<Verdict>` takes evidence as a plain string.
const evidenceOf = (reading: PanelReading): string =>
    `${reading.on.toLocaleString()} ${onLabel} · ${reading.off.toLocaleString()} ${offLabel}`;
</script>

<template>
    <!-- No background or border of its own: the row's `#below` and the group's `divide-y` already provide the boundaries. -->
    <div class="flex flex-col gap-3">
        <!-- `flush`: the row above already pays the padding. `dense`: this is that row's child, ranked below it. -->
        <Row flush density="dense" title="Measure it" :description="note">
            <template #control>
                <span class="flex shrink-0 items-center gap-1">
                    <input
                        type="number"
                        min="0"
                        max="100"
                        :value="percent"
                        :disabled="disabled"
                        aria-label="Control group, as a percentage"
                        :class="ui.inputSm('w-16 text-right')"
                        @change="(event: Event) => commitPercent(event, percent, (fraction: number) => emit(`commit`, fraction))"
                    />
                    <span class="text-xs text-muted">%</span>
                </span>
            </template>
        </Row>

        <!-- Three ranks, one fact each: the answer, what qualifies it, what it was measured over; none at control weight. -->
        <div v-if="readings[0] !== undefined" class="flex flex-col gap-2">
            <Verdict
                :value="readings[0].verdict.value"
                :unit="readings[0].verdict.unit"
                :tone="readings[0].verdict.tone"
                :detail="readings[0].verdict.detail"
                :evidence="evidenceOf(readings[0])"
            />
            <!-- Secondary readings sit one rank below the headline, so a two-metric experiment reads as one answer with a footnote. -->
            <Verdict
                v-for="more in readings.slice(1)"
                :key="more.verdict.unit"
                size="xs"
                :value="more.verdict.value"
                :unit="more.verdict.unit"
                :tone="more.verdict.tone"
            />
        </div>
    </div>
</template>
