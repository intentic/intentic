<!-- THE SESSION'S IDENTITY TILE: the leading mark on a session card, in both of the card's frames (the fleet
     board's AgentCard, the chat rail's ChatTabList) and on the rail's "Not open" search hits. One component
     because the two cards are one card in two skins, and the tile is exactly the part that must never drift
     between them: same category reading, same tint formula, same fallback.

     What it shows is the best fact known about the session, in order of how much it says:
       · a CATEGORY (sessionCategory over the title): the kind-of-work glyph on the category's tint, colour
         and shape carrying the same fact twice. The board's tooltip names it; the rail's hover note does.
       · otherwise the PROVIDER mark on neutral chrome (Avatar's own): an unnamed draft or an unreadable
         title has no category yet, and "whose runtime" is the most a tile can truthfully say about it.

     Size comes from the host (h/w and a text size on the class attr): the glyphs render at 1em, so one
     font-size on the root sets both. -->
<script setup lang="ts">
import type { AgentProvider } from "@intentic/sandbox-contract";
import { computed } from "vue";
import ProviderLogo from "../chat/ProviderLogo.vue";
import { sessionCategory } from "../composables/sessionCategory";

const props = defineProps<{ title: string | undefined; provider: AgentProvider }>();
const category = computed(() => sessionCategory(props.title));
</script>

<template>
    <span
        class="flex shrink-0 items-center justify-center rounded-md"
        :class="category === undefined ? `border border-line bg-content/5 text-muted` : `category-tile`"
        :style="category === undefined ? undefined : { '--tile-hue': category.hue }"
    >
        <Icon v-if="category !== undefined" :name="category.icon" aria-hidden="true" />
        <ProviderLogo v-else :provider="provider" />
    </span>
</template>
