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
    <span
        class="flex shrink-0 items-center justify-center rounded-md"
        :class="category === undefined ? `border border-line bg-content/5 text-muted` : `category-tile`"
        :style="category === undefined ? undefined : { '--tile-hue': category.hue }"
    >
        <Icon v-if="category !== undefined" :name="category.icon" aria-hidden="true" />
        <ProviderLogo v-else :provider="provider" />
    </span>
</template>
