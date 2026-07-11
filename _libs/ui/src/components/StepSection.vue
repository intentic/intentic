<!-- Numbered step card for the setup wizard: card chrome + a badge (the step number, or a check once
     `done`) + title, with a right-aligned `actions` slot for header affordances (an InfoHint, a "Check
     now" button). Replaces the repeated `<section>` + badge markup across the setup steps so their chrome
     stays identical; each step supplies its own (collapsed or expanded) body via the default slot. -->
<script setup lang="ts">
const { step, title, done = false } = defineProps<{ step: number; title: string; done?: boolean }>();
</script>

<template>
    <section class="flex flex-col gap-3 rounded-2xl border border-line bg-card p-5">
        <div class="flex items-center gap-2.5">
            <span
                class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-2xs font-semibold"
                :class="done ? `border-success/40 bg-success/10 text-success` : `border-line bg-canvas text-muted`"
            >
                <Icon name="check" v-if="done" :aria-label="`${title} — done`" />
                <template v-else>{{ step }}</template>
            </span>
            <h2 class="font-semibold leading-tight">{{ title }}</h2>
            <div v-if="$slots['actions']" class="ml-auto flex items-center gap-2">
                <slot name="actions" />
            </div>
        </div>
        <slot />
    </section>
</template>
