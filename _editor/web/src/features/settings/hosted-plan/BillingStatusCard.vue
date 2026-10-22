<script setup lang="ts">
import { Icon, type IconName, toneRim } from "@intentic/ui";

// Where the account stands, said the same way in every state Billing can be in (on the plan, ending, a card that
// failed, a checkout open elsewhere): a mark in the state's colour, one line, one sentence, and the one door.

type Tone = `success` | `warning` | `info` | `neutral`;

const props = defineProps<{
    tone: Tone;
    icon: IconName;
    title: string;
    detail?: string;
    // Spins the mark: the state is a wait the page is watching.
    spin?: boolean;
}>();

const MARK = {
    success: `bg-success-tint text-success`,
    warning: `bg-warning-tint text-warning`,
    info: `bg-info-tint text-info`,
    neutral: `bg-content/[0.07] text-accent`,
} as const satisfies Record<Tone, string>;

// Only a warning rims the card in its tone; every other state rests on the ordinary hairline.
const edge = (tone: Tone): string => (tone === `warning` ? toneRim(`warning`, `soft`) : `border-line`);
</script>

<template>
    <section class="flex flex-col gap-4 rounded-xl border bg-card p-5 @xl:flex-row @xl:items-center @xl:gap-5" :class="edge(props.tone)">
        <span class="flex size-11 shrink-0 items-center justify-center rounded-xl text-lg" :class="MARK[props.tone]">
            <Icon :name="props.icon" :spin="props.spin" />
        </span>
        <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h2 class="text-base font-semibold leading-tight" :class="props.tone === `warning` ? `text-warning` : `text-content`">{{ props.title }}</h2>
                <slot name="aside" />
            </div>
            <p v-if="props.detail" class="mt-1 text-xs text-muted">{{ props.detail }}</p>
            <slot />
        </div>
        <div v-if="$slots[`actions`]" class="flex shrink-0 flex-wrap items-center gap-2">
            <slot name="actions" />
        </div>
    </section>
</template>
