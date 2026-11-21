<script setup lang="ts">
import { computed } from "vue";

// A ring cut into discrete arcs, for progress through a countable list rather than a continuous fraction: the reader
// counts ticks instead of estimating a percentage. Lit arcs are drawn in `currentColor`, so a Tailwind `text-*` class
// on the element sets them; the rest wear the same faint track ProgressRing uses, so a rim that swaps between the two
// components does not change weight. Rotated to start at 12 o'clock and fill clockwise, like ProgressRing.
// `active` arcs follow the lit ones: items in hand, drawn in the lit ink at part strength, or in the info ink at full
// strength while `asking` (the work waits on the reader's answer, not on the agent).
// `seal` is a step that is not one of the list's items, the session's own ending: a bead in a notch of its own at 12
// o'clock, so the arcs stay one per item. Faint while still to come, part-lit while in hand (in the info ink while
// asking, like an active arc), whole once done. Absent, the ring has no notch and no bead.
const {
    segments,
    filled,
    active = 0,
    asking = false,
    seal,
    size = 14,
    stroke = 2,
} = defineProps<{
    segments: number;
    filled: number;
    active?: number;
    asking?: boolean;
    seal?: "open" | "active" | "closed";
    size?: number;
    stroke?: number;
}>();

// Below this many px a slot cannot hold both a tick and a gap, so the gaps close and a long list reads as a plain arc:
// the proportion stays true, only the counting is lost. Beats clamping the count, which would lie about the total.
const MIN_SLOT = 5;
const GAP = 2.5;
// What an item in hand keeps of the lit ink: enough to read as begun, little enough not to be counted as done.
const HELD = 0.45;
// The seal's bead is about twice the stroke across, so it reads as a dot on the rim rather than a stray tick, and its
// notch leaves this much clear rim on either side of it.
const BEAD = 1.1;
const SEAM_PAD = 2;
const TRACK = `color-mix(in srgb, var(--color-content) 12%, transparent)`;
// A step still to come is a dot the track's ink would lose at this size, so it is drawn a shade stronger.
const SEAL_OPEN = `color-mix(in srgb, var(--color-content) 24%, transparent)`;
const ASK = `var(--color-info)`;

const radius = computed(() => (size - stroke) / 2);
const circumference = computed(() => 2 * Math.PI * radius.value);
const beadRadius = computed(() => stroke * BEAD);
const seam = computed(() => (seal === undefined ? 0 : 2 * beadRadius.value + 2 * SEAM_PAD));
// At least one slot: a zero count would divide the circumference by nothing.
const count = computed(() => Math.max(1, Math.round(segments)));
// A slot is a tick and the gap after it. With a seal the last gap opens into the seal's notch, so the slots share the
// rim the notch leaves plus that one gap.
const roomy = computed(() => (circumference.value - seam.value) / count.value >= MIN_SLOT);
// A lone segment has no neighbour to keep apart: without a seal it closes into a whole ring rather than one notched at
// 12 o'clock, and with one it runs from one side of the notch to the other.
const gap = computed(() => (count.value > 1 && roomy.value ? GAP : 0));
const slot = computed(() => (circumference.value - seam.value + (seal === undefined ? 0 : gap.value)) / count.value);
const dash = computed(() => slot.value - gap.value);
const lit = computed(() => Math.min(count.value, Math.max(0, Math.round(filled))));
const held = computed(() => Math.min(count.value - lit.value, Math.max(0, Math.round(active))));
// The first tick starts half a notch past 12 o'clock, so the notch sits centred on it.
const lead = computed(() => -seam.value / 2);

// Slots [from, to) spelled out one by one, ending in a gap that swallows the rest of the rim. The pattern's total is
// exactly one circumference, so the browser lays it down once instead of repeating it over the rest of the rim.
const run = (from: number, to: number): string => {
    const parts = from > 0 ? [0, from * slot.value] : [];
    for (let at = from; at < to; at++) {
        parts.push(dash.value, at === to - 1 ? circumference.value - (at * slot.value + dash.value) : gap.value);
    }
    return parts.join(` `);
};
// Without a seal every slot is alike, so one [tick, gap] pair repeats round the rim; with one the notch breaks the
// repeat and the track is spelled out like the arcs over it.
const track = computed(() => (seal === undefined ? `${dash.value} ${gap.value}` : run(0, count.value)));
const arc = computed(() => run(0, lit.value));
const hand = computed(() => run(lit.value, lit.value + held.value));
const sealInk = computed(() => (seal === `closed` ? `currentColor` : seal === `active` ? (asking ? ASK : `currentColor`) : SEAL_OPEN));
const sealOpacity = computed(() => (seal === `active` && !asking ? HELD : 1));
</script>

<template>
    <svg :width="size" :height="size" :viewBox="`0 0 ${size} ${size}`" class="-rotate-90 shrink-0" aria-hidden="true">
        <circle
            data-part="track"
            :cx="size / 2"
            :cy="size / 2"
            :r="radius"
            fill="none"
            :stroke-width="stroke"
            :stroke-dasharray="track"
            :stroke-dashoffset="lead"
            :style="{ stroke: TRACK }"
        />
        <circle
            v-if="lit > 0"
            data-part="lit"
            :cx="size / 2"
            :cy="size / 2"
            :r="radius"
            fill="none"
            stroke="currentColor"
            :stroke-width="stroke"
            :stroke-dasharray="arc"
            :stroke-dashoffset="lead"
        />
        <circle
            v-if="held > 0"
            data-part="active"
            :cx="size / 2"
            :cy="size / 2"
            :r="radius"
            fill="none"
            :stroke-width="stroke"
            :stroke-dasharray="hand"
            :stroke-dashoffset="lead"
            :style="asking ? { stroke: ASK } : { stroke: 'currentColor', strokeOpacity: HELD }"
        />
        <!-- At the path's start, which the -90° turn puts at 12 o'clock. -->
        <circle
            v-if="seal !== undefined"
            data-part="seal"
            :data-seal="seal"
            :cx="size / 2 + radius"
            :cy="size / 2"
            :r="beadRadius"
            :style="{ fill: sealInk, fillOpacity: sealOpacity }"
        />
    </svg>
</template>
