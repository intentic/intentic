<!-- Status pill: shared chrome for active, error, and pending states. -->
<script lang="ts">
import { tv } from "tailwind-variants";
import { toneDot, toneWash } from "../../lib/tone.js";
import type { StatusVariant } from "./statusBadge.js";

export type { StatusVariant };

// The pill and its dot as one recipe: the tone is the kit's (tone.ts), so a badge saying "danger" is the same red as
// a notice saying it, and the size is the pill's own.
const badge = tv({
    slots: { root: `ui-status-pill whitespace-nowrap font-medium lowercase`, dot: `h-1.5 w-1.5 rounded-full` },
    variants: { size: { sm: { root: `gap-1.5 text-xs` }, xs: { root: `gap-1 text-2xs` } } },
    defaultVariants: { size: `sm` },
});
</script>

<script setup lang="ts">
const {
    variant,
    label = ``,
    dot = false,
    size = `sm`,
} = defineProps<{
    variant: StatusVariant;
    label?: string;
    dot?: boolean;
    size?: `sm` | `xs`;
}>();
</script>

<template>
    <span :class="badge({ size }).root({ class: toneWash(variant) })">
        <span v-if="dot" :class="badge().dot({ class: toneDot(variant) })"></span>
        <slot>{{ label }}</slot>
    </span>
</template>
