<script setup lang="ts">
import { computed } from "vue";
import type { AgentProvider } from "@intentic/sandbox-contract";
// The marks themselves live in @intentic/constants: the landing page's cost band draws the same five, and a
// path pasted into both is a path that eventually differs in one of them.
import { PROVIDER_BRAND_PATHS, providerFillRule, type ProviderBrand } from "@intentic/constants";

const props = defineProps<{ provider: AgentProvider }>();
// A provider with a brand mark draws it; anything else is an installed ACP agent — a generic glyph.
// Rendered as currentColor so the glyph tracks the surrounding text color (light/dark) like a font icon.
const path = computed(() => PROVIDER_BRAND_PATHS[props.provider as ProviderBrand]);
</script>

<template>
    <svg v-if="path" viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden="true">
        <path :d="path" :fill-rule="providerFillRule(provider as ProviderBrand)" />
    </svg>
    <Icon v-else name="sparkles" aria-hidden="true" />
</template>
