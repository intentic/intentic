<!-- Status pill: the app-wide chrome for state labels (active/error/pending/…). Views map their own
     domain states to a variant; this component owns only the colors and pill shape, so every view's
     badges stay visually identical. Default slot wins over `label` for icon+text bodies. -->
<script lang="ts">
export type StatusVariant = `success` | `danger` | `warning` | `info` | `neutral` | `primary`;

const VARIANT: Record<StatusVariant, string> = {
    success: `bg-success/10 text-success`,
    danger: `bg-danger/10 text-danger`,
    warning: `bg-warning/10 text-warning`,
    info: `bg-info/10 text-info`,
    neutral: `bg-subtle/10 text-subtle`,
    primary: `bg-primary-600/10 text-primary-500`,
};

const DOT: Record<StatusVariant, string> = {
    success: `bg-success`,
    danger: `bg-danger`,
    warning: `bg-warning`,
    info: `bg-info`,
    neutral: `bg-subtle`,
    primary: `bg-primary-500`,
};

const SIZE: Record<`sm` | `xs`, string> = {
    sm: `gap-1.5 px-2.5 py-1 text-xs`,
    xs: `gap-1 px-2 py-0.5 text-2xs`,
};
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
    <span class="inline-flex items-center whitespace-nowrap rounded-full font-medium" :class="[VARIANT[variant], SIZE[size]]">
        <span v-if="dot" class="h-1.5 w-1.5 rounded-full" :class="DOT[variant]"></span>
        <slot>{{ label }}</slot>
    </span>
</template>
