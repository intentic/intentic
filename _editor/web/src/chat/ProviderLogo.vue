<script setup lang="ts">
import { computed } from "vue";
import type { AgentProvider } from "@intentic/sandbox-contract";
// The marks themselves live in @intentic/constants: the landing page's cost band draws the same five, and a
// path pasted into both is a path that eventually differs in one of them.
import { PROVIDER_BRAND_PATHS, providerFillRule, type ProviderBrand } from "@intentic/constants";
import { providerGlyph } from "../composables/chat/providerCatalog";

const props = defineProps<{ provider: AgentProvider }>();
// A provider with a brand mark draws it; anything else has no vendor to draw, so it draws WHAT IT IS instead
// (providerGlyph: the trial, a model running here, a server the user pointed us at, an installed agent).
// Rendered as currentColor so the glyph tracks the surrounding text color (light/dark) like a font icon.
const path = computed(() => PROVIDER_BRAND_PATHS[props.provider as ProviderBrand]);
const glyph = computed(() => providerGlyph(props.provider));
</script>

<template>
    <svg v-if="path" viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden="true">
        <path :d="path" :fill-rule="providerFillRule(provider as ProviderBrand)" />
    </svg>
    <Icon v-else :name="glyph" aria-hidden="true" />
</template>
