<script setup lang="ts">
import { Icon, type IconName } from "@intentic/ui";

// The full-screen notice for when there's no workspace to show: daemon unreachable, still booting, or refusing
// this account. `spinner` marks a wait that resolves itself; the unauthorized gate has none. Three slots: the
// centred sentence, `#actions` for the one button, `#below` full width for a table.

defineProps<{ icon: IconName; title: string; spinner?: boolean }>();
</script>

<template>
    <div class="flex h-full w-full items-center justify-center p-8">
        <div class="flex w-full max-w-md flex-col items-center gap-4 rounded-2xl border border-line bg-card p-8 text-center">
            <span class="flex h-12 w-12 items-center justify-center rounded-2xl border border-line bg-canvas text-muted">
                <Icon :name="icon" class="text-xl" />
            </span>
            <div class="flex flex-col gap-1.5">
                <h2 class="flex items-center justify-center gap-2 text-lg font-semibold text-content">
                    <Icon v-if="spinner" name="spinner" class="text-info" spin />
                    {{ title }}
                </h2>
                <slot />
            </div>
            <slot name="actions" />
            <!-- `w-full` is what lets this opt out of the card's own centring without a second card. -->
            <div v-if="$slots['below']" class="flex w-full flex-col gap-4"><slot name="below" /></div>
        </div>
    </div>
</template>
