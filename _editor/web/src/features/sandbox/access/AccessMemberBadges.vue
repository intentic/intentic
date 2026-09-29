<!-- What a member row states about a grant: where the invite stands, and which areas of the workspace it reaches. -->
<script setup lang="ts">
import { StatusBadge, type StatusVariant } from "@intentic/ui";

defineProps<{
    status: { readonly label: string; readonly variant: StatusVariant; readonly dot: boolean };
    /** The areas' names; none at all is the whole workspace, which says nothing. */
    areas: readonly string[];
}>();
</script>

<template>
    <StatusBadge :variant="status.variant" :label="status.label" :dot="status.dot" size="xs" />
    <StatusBadge v-for="area in areas" :key="area" variant="info" :label="area" size="xs" />
</template>
