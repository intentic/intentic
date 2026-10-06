<script setup lang="ts">
import { StatusBadge } from "@intentic/ui";
import { type ReconcileContext, statusGerund, statusLabel, statusVariant } from "../features/extensions/reconcileStatus";

/* One resource's reconcile verdict as a row: its id (mono) beside a status badge, with the reason (if any) as a muted second line. */
const {
    id,
    action,
    reason,
    context = `live`,
    pending = false,
} = defineProps<{
    id: string;
    action: string;
    reason?: string;
    context?: ReconcileContext;
    pending?: boolean;
}>();
</script>

<template>
    <div class="flex items-center justify-between gap-2 rounded-md border border-line bg-canvas px-3 py-1.5">
        <span class="min-w-0">
            <span class="block truncate font-mono text-2xs text-content">{{ id }}</span>
            <span v-if="reason" class="block truncate text-2xs text-muted">{{ reason }}</span>
        </span>
        <span v-if="pending" class="flex shrink-0 items-center gap-1.5 text-2xs text-info">
            <Icon name="spinner" spin />
            {{ statusGerund(action) }}…
        </span>
        <StatusBadge v-else :variant="statusVariant(action)" size="xs" class="shrink-0">
            {{ statusLabel(action, context) }}
        </StatusBadge>
    </div>
</template>
