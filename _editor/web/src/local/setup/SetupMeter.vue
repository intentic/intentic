<!-- HOW FAR A FOLDER'S SANDBOX'S SETUP IS, on its page (LocalSandboxSetup.vue): the setup's own measure as a bar, held
     back from 100 until it says it is done, its running step in its own words, how long it has run, and roughly how long
     is left by the setup's plan (the app's setup_progress.rs). Before the setup has said where it is, the plan's whole
     length. -->
<script setup lang="ts">
import { formatElapsed, Meter } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { spanWords } from "../../components/progress/progress";

const { percent, startedAt, left } = defineProps<{
    percent: number;
    /** The setup's running step, in its own words. */
    step: string | undefined;
    /** When the setup started, Unix milliseconds. */
    startedAt: number | undefined;
    /** Roughly how many seconds are left. */
    left: number | undefined;
    /** What the bar measures, for a screen reader. */
    label: string;
}>();

const t = useT();
const now = useNow();

const elapsed = computed(() => (startedAt === undefined ? undefined : t(`common.waitProgress.elapsed`, { elapsed: formatElapsed(Math.max(0, now.value - startedAt) / 1000) })));
// Said in whole minutes past the first two, so the figure does not flicker as the plan's steps go by.
const remaining = computed(() => {
    if (left === undefined) {
        return undefined;
    }
    return left < 15 ? t(`local.sandboxSetup.almostDone`) : t(`local.sandboxSetup.left`, { left: spanWords(left * 1000) });
});
</script>

<template>
    <div class="flex flex-col gap-2">
        <div class="flex items-baseline justify-between gap-3">
            <span class="min-w-0 flex-1 truncate text-xs text-content" v-tooltip.top="step">{{ step ?? label }}</span>
            <span class="shrink-0 text-sm font-semibold tabular-nums text-content">{{ t(`local.project.percent`, { percent }) }}</span>
        </div>
        <Meter :value="percent / 100" size="md" :label="label" :valuetext="t(`local.project.percent`, { percent })" />
        <div class="flex flex-wrap items-center justify-between gap-x-3 text-2xs text-muted" aria-live="off">
            <span class="tabular-nums">{{ elapsed }}</span>
            <span v-if="remaining">{{ remaining }}</span>
        </div>
    </div>
</template>
