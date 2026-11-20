<script setup lang="ts">
import type { PoolPace } from "../../models/providers/capacity/usagePace";

// The pace tick on an allowance meter (usagePace.ts): where an even spend would have the fill by now. Sits in a
// `relative` box wrapped around the track, not inside the track, so it can stand a little proud of a hairline bar and
// is not clipped by the track's rounding. Neutral, never a tone: the fill against it already says ahead or behind,
// and the fill's own colour says how much is left. Decoration: the sentence beside every meter says the pace in words.
defineProps<{ pace: PoolPace | undefined }>();
</script>

<template>
    <span
        v-if="pace !== undefined"
        class="pointer-events-none absolute -inset-y-0.5 w-0.5 -translate-x-1/2 rounded-full bg-content/70"
        :style="{ left: `${Math.min(99, Math.max(1, pace.mark))}%` }"
        aria-hidden="true"
        data-pace-mark
    />
</template>
