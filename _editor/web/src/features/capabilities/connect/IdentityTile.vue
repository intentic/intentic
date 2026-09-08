<!--
    Session's identity mark, shared by the fleet board card, the chat rail card, and rail search hits so all three stay identical. Shows the
    session's category glyph and tint when known, otherwise falls back to the provider's mark. Size is set by the host's font-size; glyphs render at
    1em.
-->
<script setup lang="ts">
import type { AgentProvider } from "@intentic/sandbox-contract";
import { computed } from "vue";
import ProviderLogo from "../../chat/accounts/ProviderLogo.vue";
import { sessionCategory } from "../../../app/sessionCategory";

const props = defineProps<{ title: string | undefined; provider: AgentProvider }>();
const category = computed(() => sessionCategory(props.title));
</script>

<template>
    <!--
        ROUND, because this mark is worn inside a ring. The board draws the context arc around it (AgentCard), and a
        rounded SQUARE inside a circle is the shape pair that never resolves: the gap between the two is widest at the
        flats and nearly closed at the corners, so the arc reads as a stray flourish beside the tile rather than as
        its rim, and a card with no context to draw shows a small square adrift in a box sized for a circle.
        Round also lifts the constraint the square imposed: a disc has no corners to clear, so the tile can fill the
        ring at a legible glyph size instead of shrinking to keep its corners off the arc.
    -->
    <span
        class="flex shrink-0 items-center justify-center rounded-full"
        :class="category === undefined ? `border border-line bg-content/5 text-muted` : `category-tile`"
        :style="category === undefined ? undefined : { '--tile-hue': category.hue }"
    >
        <Icon v-if="category !== undefined" :name="category.icon" aria-hidden="true" />
        <ProviderLogo v-else :provider="provider" />
    </span>
</template>
