<!-- One labelled section on the Secrets page: an icon + titled label + optional count summary, an optional
     right-aligned actions slot, and a slotted body (row list, provider chips, or the add affordance). Reused by
     every group so their header chrome stays identical, while the body stays free to differ. Its root is a
     single element so the parent surface's `divide-y` separates groups. -->
<script setup lang="ts">
import { type IconName } from "@intentic-app/ui";

defineProps<{ icon: IconName; label: string; count?: string }>();
</script>

<template>
    <div>
        <div class="flex items-center gap-2.5 border-b border-line bg-subtle/10 px-4 py-2.5">
            <Icon :name="icon" class="text-sm text-muted" />
            <span class="text-sm font-semibold text-content">{{ label }}</span>
            <span v-if="count" class="text-2xs text-muted">{{ count }}</span>
            <div v-if="$slots[`actions`]" class="ml-auto flex items-center gap-2"><slot name="actions" /></div>
        </div>
        <slot />
    </div>
</template>
