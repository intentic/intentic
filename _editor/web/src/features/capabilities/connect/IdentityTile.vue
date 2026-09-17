<!-- Session's identity mark, shared by the fleet board card, the chat rail card, and rail search hits so all three stay identical. -->
<script setup lang="ts">
import type { AgentProvider } from "@intentic/sandbox-contract";
import { computed } from "vue";
import ProviderLogo from "../../chat/accounts/ProviderLogo.vue";
import { sessionCategory } from "../../../app/sessionCategory";

// `action` is the session's stored work word (AgentSummary.titleAction); rows that have none read the title instead.
const props = defineProps<{ title: string | undefined; provider: AgentProvider; action?: string }>();
const category = computed(() => sessionCategory(props.title, props.action));
</script>

<template>
    <!-- ROUND, because this mark is worn inside a ring. -->
    <span
        class="flex shrink-0 items-center justify-center rounded-full"
        :class="category === undefined ? `border border-line bg-content/5 text-muted` : `category-tile`"
        :style="category === undefined ? undefined : { '--tile-hue': category.hue }"
    >
        <Icon v-if="category !== undefined" :name="category.icon" aria-hidden="true" />
        <ProviderLogo v-else :provider="provider" />
    </span>
</template>
