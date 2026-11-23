<!-- An agent card's identity tile in its progress ring, the one drawing every fit of the card leads with (AgentCard). -->
<script setup lang="ts">
import { SegmentRing, type TooltipValue } from "@intentic/ui";
import { computed } from "vue";
import type { TileRim } from "../../../../../models/agent-status/agentStatus-lanes";
import type { FleetAgent } from "../../../../../models/fleet/useAgents-fleet";
import type { ChildTally } from "../../../../../parts/fleet/childCount";
import IdentityTile from "../../../../../parts/capabilities/IdentityTile.vue";

const { large = false, title } = defineProps<{
    agent: FleetAgent;
    rim: TileRim;
    // How many agents it started, counted inside the disc (useChildCount).
    family: ChildTally | undefined;
    hint?: TooltipValue;
    // A tile card's ring (boardGrid.ts `CardFit`), a step up: there it is the whole card, so the disc carries the title's
    // initials where it would otherwise be empty.
    large?: boolean;
    title?: string;
}>();
// The first letter or digit of the title's first two words: "Add Stripe checkout" is AS.
const initials = computed(() =>
    large && title !== undefined
        ? title
              .split(/\s+/u)
              .map((word) => word.match(/[\p{L}\p{N}]/u)?.[0] ?? ``)
              .filter((letter) => letter !== ``)
              .slice(0, 2)
              .join(``)
              .toUpperCase()
        : undefined,
);
</script>

<template>
    <!-- How many agents it started, an empty disc for one that started none; tinted amber as its context fills (sessionKind.ts contextPressure). -->
    <!-- At the scale of the corner's badges (22px), not above it: the tile is a mark beside the title, not a heading. -->
    <!-- An 18px disc and a 12px glyph: whole-pixel insets (2px, 3px), so the glyph centres crisply instead of rounding half a pixel off-centre, and the disc meets the ring with no dead band. -->
    <span v-tooltip.top="hint" class="relative flex shrink-0 items-center justify-center rounded-full" :class="large ? 'h-7 w-7' : 'h-5.5 w-5.5'">
        <!-- A tick per checklist item, the one in hand part-lit (blue while it asks you), and the session's ending as a bead at 12 o'clock, closed once it is finished (`tileRim`); `size-full` so it scales with the rem-sized tile under a larger browser font instead of the glyph spilling onto it. -->
        <SegmentRing v-bind="rim.ring" :size="large ? 28 : 22" :stroke="1.5" class="absolute inset-0 size-full" :class="rim.tone" />
        <IdentityTile :session="agent" :children="family ?? null" :initials="initials" :class="large ? 'h-5.5 w-5.5 text-sm' : 'h-4.5 w-4.5 text-xs'" />
        <!-- What a tile card pins to its ring: the dot saying it asks for the reader. -->
        <slot />
    </span>
</template>
