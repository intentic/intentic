<script setup lang="ts">
import type { IconName } from "@intentic/ui";

/* The answer to a decision card — the plan's Approve, the question's Submit, the permission's Allow once, and
 * every No beside them. One component because the three cards ask the same shape of thing and must not drift:
 * a reader who has approved a plan should recognise the permission prompt's buttons as the same control.
 *
 * `tone` is WEIGHT, not agreement. The permission card's "Always allow …" is an approval wearing the secondary
 * tone, because the card's primary answer is the one-off allow and a second filled button beside it would make
 * the pair a coin flip. So: primary is the answer the card is asking for, secondary is everything else.
 *
 * `compact` is the question card's Submit/Dismiss, which sit inline with the option rows and the Other field and
 * would out-weigh them at full size. Desktop only — the touch targets below stay 2.75rem in every tone, since a
 * finger has the same width whatever the button is next to. */

const { tone, icon, compact } = defineProps<{ tone: "primary" | "secondary"; icon?: IconName; compact?: boolean }>();
</script>

<template>
    <button
        type="button"
        class="inline-flex cursor-pointer items-center gap-[0.45rem] rounded-md font-semibold transition-colors disabled:cursor-default disabled:opacity-50 max-md:h-11 max-md:px-5"
        :class="[
            compact ? 'h-[1.875rem] px-3 text-2xs' : 'h-[2.125rem] px-[0.9rem] text-xs',
            tone === 'primary'
                ? 'border border-primary-fill/20 bg-primary-fill/10 text-primary-fill hover:border-primary-fill/35 hover:bg-primary-fill/18'
                : 'border border-line-strong bg-transparent text-content hover:border-content hover:bg-content/8',
        ]"
    >
        <Icon v-if="icon" :name="icon" :class="compact ? 'text-2xs' : 'text-xs'" />
        <slot />
    </button>
</template>
