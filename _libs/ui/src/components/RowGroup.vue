<!-- Grouped-list section: an optional uppercase label (with an optional count / #actions cluster) floating
     above ONE bordered surface whose direct children are hairline-divided rows. The app-wide replacement for
     stacking a separate <Card> per option — related settings share a surface, so the border means "these
     belong together" again instead of boxing every line. Pair with <Row>; stack multiple RowGroups in a
     `flex flex-col gap-6` page wrapper. Mirrors the grouped-list already used on the Secrets page. -->
<script setup lang="ts">
import { cmp } from "../cmp.js";

defineProps<{ label?: string; count?: string | number }>();
</script>

<template>
    <section>
        <div v-if="label !== undefined || $slots[`actions`]" class="mb-2 flex items-center gap-2 px-0.5">
            <span v-if="label !== undefined" :class="cmp.sectionLabel()">{{ label }}</span>
            <span v-if="count !== undefined" class="text-2xs font-medium text-subtle">{{ count }}</span>
            <div v-if="$slots[`actions`]" class="ml-auto flex items-center gap-2"><slot name="actions" /></div>
        </div>
        <div class="divide-y divide-line overflow-hidden rounded-lg border border-line bg-card">
            <slot />
        </div>
    </section>
</template>
