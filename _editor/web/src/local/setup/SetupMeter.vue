<!-- HOW FAR A FOLDER'S SANDBOX'S SETUP, OR ITS FIRST COPY, IS, on its page (LocalSandboxSetup.vue): the measure as a
     bar, held back from 100 until the work says it is done, its running step in its own words, what is measured beside
     it (the copy's bytes), how long it has run, and roughly how long is left: by the setup's plan (the app's
     setup_progress.rs) where there is one, else by the pace so far, once a twentieth of it is behind. -->
<script setup lang="ts">
import { formatElapsed, Meter } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { spanWords } from "../../components/progress/progress";

const { percent, startedAt, left, measure } = defineProps<{
    percent: number;
    /** The running step, in its own words. */
    step: string | undefined;
    /** When what is measured began, Unix milliseconds. */
    startedAt: number | undefined;
    /** Roughly how many seconds are left by a plan; undefined to reckon it from the pace. */
    left: number | undefined;
    /** What is measured beside the time, like the copy's bytes in of bytes to copy. */
    measure?: string | undefined;
    /** What the bar measures, for a screen reader. */
    label: string;
}>();

const t = useT();
const now = useNow();

const ran = computed(() => (startedAt === undefined ? undefined : Math.max(0, now.value - startedAt) / 1000));
const elapsed = computed(() => (ran.value === undefined ? undefined : t(`common.waitProgress.elapsed`, { elapsed: formatElapsed(ran.value) })));
// The pace is no guide until some of the work is behind it: a twentieth, and a few seconds of it.
const PACE_FROM_PERCENT = 5;
const PACE_FROM_SECONDS = 3;
const secondsLeft = computed(() => {
    if (left !== undefined) {
        return left;
    }
    if (ran.value === undefined || percent < PACE_FROM_PERCENT || ran.value < PACE_FROM_SECONDS) {
        return undefined;
    }
    return (ran.value * (100 - percent)) / percent;
});
// Said in whole minutes past the first two, so the figure does not flicker as the plan's steps go by; "almost done" only
// near the end, since a fast copy has a few seconds left halfway through too.
const ALMOST_SECONDS = 15;
const ALMOST_PERCENT = 75;
const remaining = computed(() => {
    const seconds = secondsLeft.value;
    if (seconds === undefined) {
        return undefined;
    }
    return seconds < ALMOST_SECONDS && percent >= ALMOST_PERCENT
        ? t(`local.sandboxSetup.almostDone`)
        : t(`local.sandboxSetup.left`, { left: spanWords(seconds * 1000) });
});
const said = computed(() => [measure, elapsed.value].filter((part): part is string => part !== undefined).join(` · `));
</script>

<template>
    <div class="flex flex-col gap-2">
        <div class="flex items-baseline justify-between gap-3">
            <span class="min-w-0 flex-1 truncate text-xs text-content" v-tooltip.top="step">{{ step ?? label }}</span>
            <span class="shrink-0 text-sm font-semibold tabular-nums text-content">{{ t(`local.project.percent`, { percent }) }}</span>
        </div>
        <Meter :value="percent / 100" size="md" :label="label" :valuetext="t(`local.project.percent`, { percent })" />
        <div class="flex flex-wrap items-center justify-between gap-x-3 text-2xs text-muted" aria-live="off">
            <span class="tabular-nums">{{ said }}</span>
            <span v-if="remaining">{{ remaining }}</span>
        </div>
    </div>
</template>
