<!--
    Reference column beside a capability's form: the credential guide, what applying it does to the sandbox, and the card's own note. Ordered by when
    it's needed — guide before the first field, effects before the submit, the card's note last.
-->
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
        <!-- Unboxed, unlike the two panels above it. It is prose about the card rather than a list of facts
             about the sandbox, and a third bordered box here turns a column of reference into a stack of
             equally-weighted cards with nothing telling the reader which one to read first. -->
        <p v-if="entry.hint" class="px-1 text-xs leading-relaxed text-muted">{{ entry.hint }}</p>
    </div>
</template>
