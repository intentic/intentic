<!-- How hard a model thinks, drawn as the composer draws it: the model's own ladder, lit up to the rung in effect. -->
<script setup lang="ts">
const { rung, rungs } = defineProps<{
    /** The rung in effect, from 0. */
    rung: number;
    /** How many the model's ladder has. */
    rungs: number;
}>();

// One shade per step, the weakest at half the brand and the strongest near all of it: the composer's own fill
// (effortScale.ts `effortRungFill`), so a tier reads here the way the reader set their own.
const fill = (index: number): string | undefined =>
    index > rung ? undefined : `color-mix(in oklab, var(--color-primary-500) ${50 + (index / Math.max(1, rungs - 1)) * 45}%, transparent)`;
</script>

<template>
    <span class="flex shrink-0 items-center gap-0.5" aria-hidden="true">
        <span
            v-for="index in rungs"
            :key="index"
            class="h-3 w-1 rounded-xs"
            :class="fill(index - 1) === undefined ? `bg-content/10` : ``"
            :style="fill(index - 1) === undefined ? undefined : { backgroundColor: fill(index - 1) }"
        ></span>
    </span>
</template>
