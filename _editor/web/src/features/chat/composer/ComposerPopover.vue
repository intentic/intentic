<script setup lang="ts">
import { Icon, type IconName, SectionHeader } from "@intentic/ui";

// Chrome for the panel above the composer while a trigger character (`@`, `/`) is live: the raised
// surface and header naming what's being picked. Absolutely positioned against the composer, not an
// <AnchoredOverlay>, since it's a sheet pinned to the full width of the box being typed in, tracking
// that width as it grows.

defineProps<{
    icon: IconName;
    title: string;
    /** A lookup is in flight: the spinner rides the header rather than replacing the rows already shown. */
    busy?: boolean;
}>();
</script>

<template>
    <div class="absolute bottom-full left-0 right-0 z-20 mb-1 overflow-hidden rounded-xl border border-line-strong bg-card shadow-lg">
        <SectionHeader :label="title" density="dense" class="border-b border-line px-3 py-1.5" data-popover-header>
            <template #mark><Icon :name="icon" class="text-2xs text-subtle" /></template>
            <template v-if="busy" #info><Icon name="spinner" class="text-2xs text-subtle" spin /></template>
        </SectionHeader>
        <slot />
    </div>
</template>
