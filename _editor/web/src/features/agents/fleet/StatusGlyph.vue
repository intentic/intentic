<script setup lang="ts">
import { computed } from "vue";
import type { UnfinishedWork } from "@intentic/sandbox-contract";
import type { IconName } from "@intentic/ui";
import { unfinishedHint } from "./unfinishedHint";

// The fleet's status glyph (agentStatusMeta) with the one thing a resting status can't say on its own: that the turn
// which settled it stopped short (AgentSummary.unfinished). One corner, one element, both facts; the board's card
// used to say the second on a chip of its own in the body, and a lane of finished cards each wearing a green check
// and an amber "Unfinished" pill was two answers to one question.
// The dot is a shape, not a hue: success and warning are the pair a red-green reader confuses, so recolouring the
// check would say nothing to them. The status glyph stays as it was, since "landed" and "ready to land" are still
// different places for the work to be.
// The hover carries the sentence, as the chip's did; the accessible name is the same string, since a tooltip is
// never announced.

const props = defineProps<{
    meta: { icon: IconName; spin?: boolean; label: string; class: string };
    // What the last turn left open, as the daemon measured it at that turn's finish; the daemon sends it only for a
    // card at rest.
    unfinished?: UnfinishedWork | undefined;
    // Host's tick, for the hover's age; the mark's props are static once the turn ends, so without a live tick it
    // would freeze at build time. Optional, since a still surface renders a correct age anyway.
    now?: number | undefined;
}>();

const hint = computed(() =>
    props.unfinished === undefined ? props.meta.label : `${props.meta.label}. ${unfinishedHint(props.unfinished, props.now)}`,
);
</script>

<template>
    <!--
        `relative` so the dot rides the glyph's own corner; `inline-flex` keeps the span the glyph's size, not the line's.
        Size comes from the host's text class on this root (the glyph is 1em), so the card and the header each keep their own.
    -->
    <span v-tooltip.top="hint" :aria-label="hint" role="img" class="relative inline-flex shrink-0 items-center">
        <Icon :name="meta.icon" :spin="meta.spin" :class="meta.class" aria-hidden="true" />
        <!--
            Ringed in the card's own fill so it reads as sitting on the glyph rather than touching it; the same cut-out
            the presence avatars use.
        -->
        <span
            v-if="unfinished !== undefined"
            data-unfinished
            class="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-warning ring-2 ring-card"
            aria-hidden="true"
        />
    </span>
</template>
