<!-- Reference column beside a capability's form: the credential guide, what applying it does to the sandbox, and the tile's own note. -->
<script setup lang="ts">
import type { CapabilityCatalogEntry, CapabilityEffect } from "@intentic/capability-catalog";
import CapabilityEffects from "./CapabilityEffects.vue";
import CredentialGuide from "./CredentialGuide.vue";

defineProps<{
    entry: CapabilityCatalogEntry;
    values: Record<string, string>;
    effects: readonly CapabilityEffect[];
}>();
</script>

<template>
    <div class="flex flex-col gap-3">
        <CredentialGuide v-if="entry.guide" :entry="entry" :values="values" />
        <CapabilityEffects :effects="effects" />
<!-- Unboxed, unlike the two panels above it. -->
        <p v-if="entry.hint" class="px-1 text-xs leading-relaxed text-muted">{{ entry.hint }}</p>
    </div>
</template>
