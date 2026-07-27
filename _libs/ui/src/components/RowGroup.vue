<!-- Grouped-list section: an optional uppercase label (with an optional count / #actions cluster) floating
     above ONE bordered surface whose direct children are hairline-divided rows. The app-wide replacement for
     stacking a separate <Card> per option — related settings share a surface, so the border means "these
     belong together" again instead of boxing every line. Pair with <Row>; stack multiple RowGroups in a
     `flex flex-col gap-6` page wrapper. Mirrors the grouped-list already used on the Secrets page. -->
<script setup lang="ts">
import { cmp } from "../cmp.js";

// `caption` names the group's SUBJECT when the label alone leaves it ambiguous ("Plan limits — your whole
// Claude plan, not this sandbox"). It sits inline with the label rather than under the surface because a reader
// who misidentifies the subject has already misread every number below by the time a footnote reaches them.
defineProps<{ label?: string; count?: string | number; caption?: string }>();
</script>

<template>
    <section>
        <div v-if="label !== undefined || $slots[`info`] || $slots[`actions`]" class="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 px-0.5">
            <span v-if="label !== undefined" :class="cmp.sectionLabel()">{{ label }}</span>
            <!-- Butted against the label (like PageHeader's own #info) so an <InfoHint>/<InfoDialog> reads as
                 belonging to the group's NAME, not to the first row under it. -->
            <slot name="info" />
            <span v-if="count !== undefined" class="text-2xs font-medium text-subtle">{{ count }}</span>
            <span v-if="caption !== undefined" class="min-w-0 text-2xs text-subtle">{{ caption }}</span>
            <div v-if="$slots[`actions`]" class="ml-auto flex items-center gap-2"><slot name="actions" /></div>
        </div>
        <div class="divide-y divide-line overflow-hidden rounded-lg border border-line bg-card">
            <slot />
        </div>
    </section>
</template>
