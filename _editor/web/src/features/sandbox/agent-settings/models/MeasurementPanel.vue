<script lang="ts">
import type { ExperimentVerdict } from "../../usage/savingsChart";

/* A plain <script> block purely so the shape a caller has to build is EXPORTED: `<script setup>` cannot carry
 * an export, and a type its callers assemble by hand is exactly the thing that should be named once. */
export interface PanelReading {
    readonly verdict: ExperimentVerdict;
    /* The two arms' sample sizes. They travel with the verdict because this row has no chart to carry them
     * (the Usage tab's does), and a figure with no account of how much data is behind it is one a reader
     * cannot weigh. */
    readonly on: number;
    readonly off: number;
}
</script>

<script setup lang="ts">
import { Row, ui, Verdict } from "@intentic/ui";
import { commitPercent } from "./numberInputs";

/* THE "MEASURE IT" BLOCK (a setting's control group and what its experiment has said so far) written once for
 * the two settings that carry one: the iq search teaching, and the output cleaners.
 *
 * ONE COMPONENT BECAUSE THE SHAPE THEY HAD DRIFTED INTO WAS THE FAULT. The rows glued four separate facts —
 * the verdict, its margin, how much sample is still owed, and the two arms' sizes — into a single sentence
 * joined by em dashes, set at one size, sitting under a sub-control of the same weight as the row's own
 * description. Four facts at one rank read as none, and the row carrying the most information on the page was
 * the one nobody could read.
 *
 * IT IS BUILT OUT OF THE KIT NOW, AND THAT IS THE SECOND HALF OF THE SAME FIX. This block used to be a
 * `rounded-lg bg-canvas px-3 py-2.5` well with a hairline through it, hand-drawn inside a <Row>'s `#below`, and
 * every part of that was a rule already written down somewhere else:
 *
 *   · `#below` exists to keep a row's continuation INSIDE the row's own hairline boundary "instead of spawning
 *     its own boxed inset" (<Row>). This was the boxed inset.
 *   · A fill under a row's header splits the row down a colour change and makes the lower half read as the
 *     page's rather than the name's — <DisclosureRow> writes that up as the bug three hand-rolled drawers hit.
 *   · `px-3 py-2.5` is in no tier. Compact rows are `px-4 py-2.5`, so the well's edge sat four pixels inside
 *     the text column of the row it belongs to. <RowNote>'s header is twenty lines about that exact failure.
 *   · The label half — a title, a one-line description, a control on the right — IS <Row>'s anatomy, drawn by
 *     hand at a size the tier table does not contain, and its sibling in <AgentCommandOutput> had drawn the
 *     same thing a third way. It is a `flush dense` <Row> now: one rank under the setting it belongs to, so it
 *     reads as that setting's child rather than as a second setting.
 *
 * THE FIRST READING IS THE HEADLINE, and the rule lives here rather than at each call site: an experiment has
 * exactly one (savingsChart.ts, verdictsOf), and the others are second readings of the same subject. <Verdict>
 * owns how the ranks are drawn, and draws them the same way the Usage tab's savings cards do — same report,
 * same shape, so a reader crossing the two tabs is not asked to recognise it twice.
 *
 * THE METHODOLOGY IS NOT HERE. Why a control group is needed at all, and why an arm is pinned for a whole
 * conversation, are paragraphs: they belong in the group's (i), which is a dialog with room for them. A
 * settings row is read in a glance or not at all, so it gets one line: what the number does. */

const {
    percent,
    readings,
    note,
    onLabel,
    offLabel,
    disabled = false,
} = defineProps<{
    /** The holdout as the whole percent the box shows. */
    percent: number;
    /** Headline first: see above. Empty until the daemon has an experiment to report. */
    readings: readonly PanelReading[];
    /** ONE line saying what the box does. Anything longer belongs in the group's (i). */
    note: string;
    /** What each arm is called, in the reader's words: "steered" / "unsteered", "taught" / "cold". */
    onLabel: string;
    offLabel: string;
    disabled?: boolean;
}>();

const emit = defineEmits<{ commit: [fraction: number] }>();

/* The two arms' sizes as one line. Assembled here rather than in the template because <Verdict> takes it as a
 * string: the component's job is the RANKS a reading is drawn in, and it has no business knowing that this
 * particular evidence happens to be two counts with a middot between them. */
const evidenceOf = (reading: PanelReading): string =>
    `${reading.on.toLocaleString()} ${onLabel} · ${reading.off.toLocaleString()} ${offLabel}`;
</script>

<template>
    <!-- NO SURFACE OF ITS OWN. The row's `#below` already sits inside the row's hairline, and the group's
         `divide-y` already separates this setting from the next one: a fill here would be a third boundary
         saying what two are saying, and the one that reads as a panel dropped on the page. -->
    <div class="flex flex-col gap-3">
        <!-- `flush` because the row above already paid for the padding, `dense` because this is that row's
             child and has to read a rank under it. Both from the tier table rather than from four numbers. -->
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

        <!-- WHAT IT HAS SAID SO FAR. Three ranks, one fact each: the answer, what qualifies it, what it was
             measured over. Nothing here is a control, so nothing here is at control weight. -->
        <div v-if="readings[0] !== undefined" class="flex flex-col gap-2">
            <Verdict
                :value="readings[0].verdict.value"
                :unit="readings[0].verdict.unit"
                :tone="readings[0].verdict.tone"
                :detail="readings[0].verdict.detail"
                :evidence="evidenceOf(readings[0])"
            />
            <!-- Second readings of the same experiment: one rank below the headline, so a two-metric
                 experiment reads as one answer with a footnote rather than as two answers. -->
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
