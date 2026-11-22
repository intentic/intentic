<script setup lang="ts">
import { computed } from "vue";
import type { HostedWaitView } from "./hostedWait";

// A healthy wait on a machine of ours: one bar for how far it has got, one row per step, the current one spinning, and the
// note under them that carries the origin's estimate and the time waited. A failed wait says its problem instead, which is
// the caller's to draw (add/AddSandboxRun.vue offers a start-over beside it), on Home and in its dialog alike. Worn like a
// machine's steps (components/progress/StagedProgress.vue): the same marks, and a step larger as Home's page (`page`).

const { wait, page = false } = defineProps<{ wait: Pick<HostedWaitView, `steps` | `note`>; page?: boolean }>();

// Each passed step full and the one under way half, since nothing in it is counted (as newSandboxGauge.ts reads it).
const share = computed(() => {
    const done = wait.steps.filter((step) => step.state === `done`).length;
    const going = wait.steps.some((step) => step.state === `active`) ? 0.5 : 0;
    return wait.steps.length === 0 ? 0 : Math.round(((done + going) / wait.steps.length) * 100);
});
const active = computed(() => wait.steps.find((step) => step.state === `active`)?.label);
</script>

<template>
    <div
        class="h-2 overflow-hidden rounded-full bg-content/10"
        role="progressbar"
        :aria-label="active"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-valuenow="share"
        data-hosted-bar
    >
        <div class="h-full rounded-full bg-primary-400 transition-[width] duration-500 ease-out" :style="{ width: `${Math.max(share, 2)}%` }" />
    </div>
    <ol class="flex flex-col gap-2">
        <li v-for="step in wait.steps" :key="step.key" class="flex items-center gap-2.5" :class="page ? `text-sm` : `text-xs`">
            <Icon
                :name="step.state === `done` ? `check-circle` : step.state === `active` ? `spinner` : `circle`"
                :spin="step.state === `active`"
                class="shrink-0"
                :class="step.state === `done` ? `text-success` : step.state === `active` ? `text-accent` : `text-subtle`"
            />
            <span :class="step.state === `active` ? `font-medium text-content` : step.state === `done` ? `text-muted` : `text-subtle`">{{ step.label }}</span>
        </li>
    </ol>
    <p class="text-muted" :class="page ? `text-sm` : `text-xs`">{{ wait.note }}</p>
</template>
