<script setup lang="ts">
import { computed } from "vue";

// How close a quantity is to its limit, as a bar: the fill says how close, the track a lighter step of the same tone
// is the room left. One drawing for every meter in the app, so a disk, a CPU and a share of memory read the same way.
// Width is the caller's (a class on the element); height is the size. Named, it is a `meter` a screen reader speaks;
// unnamed, it repeats a figure printed beside it and hides.

export type MeterTone = `accent` | `muted` | `warning`;

const {
    value,
    tone = `accent`,
    size = `sm`,
    label,
    valuetext,
} = defineProps<{
    // The filled share, 0 to 1; undefined (not measured) draws an empty track.
    value: number | undefined;
    tone?: MeterTone;
    // `sm` is the dense 4px bar of a status line or a figure list, `md` the 8px bar a card stands on its own.
    size?: `sm` | `md`;
    label?: string;
    // What the fill means in words ("12 GB of 40 GB"), spoken instead of a bare percentage.
    valuetext?: string;
}>();

const TONES: Record<MeterTone, { readonly track: string; readonly fill: string }> = {
    accent: { track: `bg-primary-600/15`, fill: `bg-primary-600` },
    muted: { track: `bg-content/10`, fill: `bg-content/35` },
    warning: { track: `bg-warning/15`, fill: `bg-warning` },
};

const percent = computed(() => (value === undefined ? undefined : Math.round(Math.min(1, Math.max(0, value)) * 100)));
</script>

<template>
    <div
        class="overflow-hidden rounded-full"
        :class="[TONES[tone].track, size === `md` ? `h-2` : `h-1`]"
        v-bind="
            label === undefined
                ? { 'aria-hidden': 'true' }
                : {
                      role: 'meter',
                      'aria-label': label,
                      'aria-valuemin': 0,
                      'aria-valuemax': 100,
                      'aria-valuenow': percent,
                      'aria-valuetext': valuetext,
                  }
        "
    >
        <div class="h-full rounded-full transition-[width] duration-500" :class="TONES[tone].fill" :style="{ width: `${percent ?? 0}%` }" />
    </div>
</template>
