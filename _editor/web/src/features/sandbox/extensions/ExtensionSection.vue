<script setup lang="ts">
import { Section } from "@intentic/ui";

// One part of an installed extension's page: the house section header over its content, stacked at every width. A
// fixed label column beside the content took a third of a column already capped below the reading measure, and what
// was left was split again by each control. The page rules the sections apart; a section draws no box of its own.
// `caption` is the section's legend (how many routes were used), the first line of the content rather than a second
// line under the header, which takes none.

const { label, caption } = defineProps<{ label: string; caption?: string }>();
</script>

<template>
    <Section :label :heading="3" class="py-5">
        <p v-if="caption" class="mb-2 text-xs text-subtle">{{ caption }}</p>
        <slot />
    </Section>
</template>
