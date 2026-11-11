<script setup lang="ts">
import type { FleetAgent } from "../../models/fleet/useAgents-fleet";
import { useChildCount } from "./childCount";

// The family count as a chip in a metadata row (the chat rail's row): a number in a row the row already draws changes
// no row's height. The board card wears the same count inside its identity disc instead (IdentityTile `children`).
const props = defineProps<{ agent: FleetAgent }>();
const count = useChildCount(() => props.agent);
</script>

<template>
    <span
        v-if="count !== undefined"
        v-tooltip.top="count.hint"
        role="img"
        :aria-label="count.hint"
        class="inline-flex shrink-0 items-center gap-0.5 tabular-nums"
        :class="count.running > 0 ? `text-link` : ``"
    >
        <Icon :name="count.runs ? `history` : `subagents`" class="shrink-0 text-2xs" />{{ count.running > 0 ? `${count.running}/${count.total}` : count.total }}
    </span>
</template>
