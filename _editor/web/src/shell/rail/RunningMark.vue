<script setup lang="ts">
import Icon from "@intentic/ui/icon";
import { RUNNING_MARK_CLASS } from "../../core-views/viewBadge";

/*
 * "Something is running here", drawn once for every surface that shows a tile: the rail's navigation tiles and its
 * live-runtime cluster, the phone's tab bar, the Menu page's rows. One component because it is one claim, and the
 * moment it is inline markup in four templates the four drift apart in size, ink and whether they spin.
 *
 * IT TURNS, AND THAT IS THE SIGNAL. A corner glyph that holds still is indistinguishable from the note in the corner
 * beside it; motion answers "is anything happening in there" before the shape is read at all. The turn is SVG's own
 * (Icon's `spin`, SMIL), not a CSS animation: request-driven CSS animation is banned app-wide, since Chrome DevTools
 * rebuilds an open Styles panel every time one starts or stops (reducedMotion.test.ts). Reduced motion is answered
 * there too, by slowing the turn rather than stopping it — a spinner that doesn't move reads as stuck.
 *
 * No plate and no tone: a coloured pill is what an errand wears, and running is never one. Positioning belongs to the
 * caller, which knows which corner its own badge left free; `class` lands on the root through attribute inheritance.
 *
 * 0.75rem, not the 0.7rem this started at: at 12px the glyph's 24-unit grid halves exactly, so every edge in the
 * drawing lands on a whole or half device pixel instead of a third of one. The ring is a ring rather than a rumour of
 * one, and it matches the `text-xs` label it sits beside on the Menu page.
 */
</script>

<template>
    <!-- aria-hidden: the sentence is already in the tile's own label, and a second voice here would say it twice. -->
    <span class="flex leading-none" :class="RUNNING_MARK_CLASS" aria-hidden="true">
        <Icon name="spinner" spin class="text-[0.75rem]" />
    </span>
</template>
