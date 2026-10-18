<!-- HOW FAR THIS COMPUTER'S SANDBOX'S SETUP IS, on its card (LocalMachineCard.vue): the setup's own estimate as a bar,
     held back from 100 until it says it is done, its running step in its own words, and the number. Drawn under the
     sandbox's step when the card lists a folder's steps, under the title when it does not. -->
<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";

defineProps<{
    percent: number;
    /** The setup's running step, in its own words. */
    step: string | undefined;
    /** What the bar measures, for a screen reader. */
    label: string;
}>();

const t = useT();
</script>

<template>
    <div>
        <div class="h-1 overflow-hidden rounded-full bg-line" role="progressbar" :aria-valuenow="percent" aria-valuemin="0" aria-valuemax="100" :aria-label="label">
            <div class="h-full rounded-full bg-primary-500 transition-[width] duration-700 ease-smooth" :style="{ width: `${percent}%` }"></div>
        </div>
        <div class="mt-1.5 flex items-center gap-3 text-2xs">
            <span class="min-w-0 flex-1 truncate text-subtle" v-tooltip.top="step">{{ step }}</span>
            <span class="shrink-0 tabular-nums text-muted">{{ t(`local.project.percent`, { percent }) }}</span>
        </div>
    </div>
</template>
