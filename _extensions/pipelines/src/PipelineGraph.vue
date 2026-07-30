<script setup lang="ts">
import type { PipelineJob, PipelineStatus } from "@intentic/sandbox-contract";
import { Icon, Popover, StatusBadge, type StatusVariant } from "@intentic/extension-ui";
import { computed, ref } from "vue";

/* Inline mini pipeline graph — the GitLab-style connected circles that show each stage's aggregate status
 * at a glance. Jobs are grouped by `stage` (GitLab's native concept; GitHub Actions jobs each become their
 * own single-job stage). Each circle's color reflects the worst status of its jobs; clicking a circle opens
 * a popover listing the individual jobs. Connecting lines between circles visualize the sequential flow. */

const { jobs } = defineProps<{ jobs: readonly PipelineJob[] }>();

interface Stage {
    readonly name: string;
    status: PipelineStatus;
    readonly jobs: PipelineJob[];
}

const STATUS_WEIGHT: Record<PipelineStatus, number> = { failed: 0, running: 1, canceled: 2, skipped: 3, success: 4 };
const worstStatus = (statuses: PipelineStatus[]): PipelineStatus =>
    statuses.reduce((worst, s) => (STATUS_WEIGHT[s] < STATUS_WEIGHT[worst] ? s : worst), `success` as PipelineStatus);

const stages = computed((): Stage[] => {
    const ordered: Stage[] = [];
    const seen = new Map<string, Stage>();
    for (const job of jobs) {
        const key = job.stage ?? job.name;
        const existing = seen.get(key);
        if (existing === undefined) {
            const stage: Stage = { name: key, status: job.status, jobs: [job] };
            seen.set(key, stage);
            ordered.push(stage);
        } else {
            existing.jobs.push(job);
            existing.status = worstStatus(existing.jobs.map((j) => j.status));
        }
    }
    return ordered;
});

const activePopover = ref<string | undefined>();
const popoverRefs = ref<Record<string, InstanceType<typeof Popover> | null>>({});
const toggleStage = (name: string, event: Event): void => {
    // Close previous if different.
    if (activePopover.value !== undefined && activePopover.value !== name) {
        popoverRefs.value[activePopover.value]?.hide();
    }
    popoverRefs.value[name]?.toggle(event);
    activePopover.value = activePopover.value === name ? undefined : name;
};

const circleColor = (status: PipelineStatus): string =>
    status === `success`
        ? `border-success bg-success/20 text-success`
        : status === `failed`
          ? `border-danger bg-danger/20 text-danger`
          : status === `running`
            ? `border-info bg-info/20 text-info`
            : `border-subtle/60 bg-subtle/10 text-subtle`;

const statusVariant = (status: PipelineStatus): StatusVariant =>
    status === `success` ? `success` : status === `failed` ? `danger` : status === `running` ? `info` : `neutral`;

const statusLabel = (status: PipelineStatus): string =>
    status === `success` ? `Passed` : status === `failed` ? `Failed` : status === `running` ? `Running` : status === `canceled` ? `Canceled` : `Skipped`;

const statusIcon = (status: PipelineStatus): string =>
    status === `success` ? `check` : status === `failed` ? `exclamation-circle` : status === `running` ? `spinner` : status === `canceled` ? `stop` : `forward`;

const jobDuration = (job: PipelineJob): string | undefined => {
    if (job.durationSeconds === undefined) return undefined;
    const m = Math.floor(job.durationSeconds / 60);
    return m > 0 ? `${m}m ${job.durationSeconds % 60}s` : `${job.durationSeconds}s`;
};
</script>

<template>
    <div class="flex items-center gap-0" @click.stop>
        <template v-for="(stage, idx) in stages" :key="stage.name">
            <!-- Connector line -->
            <div v-if="idx > 0" class="h-px w-3 shrink-0 bg-line"></div>

            <!-- Stage circle -->
            <button
                type="button"
                class="relative flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-full border transition-all hover:scale-110"
                :class="circleColor(stage.status)"
                :title="stage.name"
                @click="toggleStage(stage.name, $event)"
            >
                <Icon
                    :name="statusIcon(stage.status)"
                    class="text-2xs"
                    :class="stage.status === `running` ? `animate-spin` : ``"
                />
            </button>

            <!-- Stage popover -->
            <Popover :ref="(el: any) => { popoverRefs[stage.name] = el; }">
                <div class="flex w-64 flex-col gap-2 p-1">
                    <div class="flex items-center gap-2">
                        <span class="text-sm font-semibold text-content">{{ stage.name }}</span>
                        <StatusBadge :variant="statusVariant(stage.status)" :label="statusLabel(stage.status)" size="xs" />
                    </div>
                    <div class="flex flex-col divide-y divide-line">
                        <div v-for="job in stage.jobs" :key="job.name" class="flex items-center gap-2 py-1.5">
                            <Icon
                                :name="statusIcon(job.status)"
                                class="shrink-0 text-xs"
                                :class="[
                                    job.status === `success` ? `text-success` : ``,
                                    job.status === `failed` ? `text-danger` : ``,
                                    job.status === `running` ? `text-info animate-spin` : ``,
                                    job.status === `canceled` || job.status === `skipped` ? `text-subtle` : ``,
                                ]"
                            />
                            <span class="min-w-0 flex-1 truncate text-xs" :class="job.status === `failed` ? `font-medium text-danger` : `text-content`">
                                {{ job.name }}
                            </span>
                            <span v-if="jobDuration(job)" class="shrink-0 text-2xs text-subtle">{{ jobDuration(job) }}</span>
                        </div>
                    </div>
                </div>
            </Popover>
        </template>
    </div>
</template>
