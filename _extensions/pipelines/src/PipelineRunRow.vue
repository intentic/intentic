<script setup lang="ts">
import type { PipelineRun } from "@intentic/sandbox-contract";
import { Button, Icon, StatusBadge, type StatusVariant, timeAgo } from "@intentic/extension-ui";
import { computed, ref } from "vue";
import PipelineGraph from "./PipelineGraph.vue";
import { useRunJobs } from "./useRunJobs";

/* One pipeline run row: auto-fetches its jobs on mount so the inline graph renders without a click,
 * and offers an expand toggle for the detailed job list. The parent owns the action callbacks. */

const props = defineProps<{
    run: PipelineRun;
    busy: string | undefined;
}>();
const emit = defineEmits<{
    rerun: [run: PipelineRun];
    cancel: [run: PipelineRun];
    fix: [run: PipelineRun];
}>();

// Auto-fetch jobs for this run (vue-query caches per queryKey, so each row gets its own cache entry).
const runRef = computed(() => props.run);
const { jobs, isLoading: jobsLoading } = useRunJobs(runRef);

// Expand/collapse for detailed job list.
const expanded = ref(false);

const actionKey = `${props.run.host}:${props.run.project}:${props.run.runId}`;

const statusVariant = (status: PipelineRun[`status`]): StatusVariant =>
    status === `success` ? `success` : status === `failed` ? `danger` : status === `running` ? `info` : `neutral`;
const statusLabel = (status: PipelineRun[`status`]): string =>
    status === `success` ? `Passed` : status === `failed` ? `Failed` : status === `running` ? `Running` : status === `canceled` ? `Canceled` : `Skipped`;
const statusIcon = (status: PipelineRun[`status`]): string =>
    status === `success` ? `check-circle` : status === `failed` ? `exclamation-circle` : status === `running` ? `spinner` : status === `canceled` ? `stop` : `forward`;

const borderColor = computed(() =>
    props.run.status === `success`
        ? `border-l-success`
        : props.run.status === `failed`
          ? `border-l-danger`
          : props.run.status === `running`
            ? `border-l-info`
            : `border-l-subtle/40`,
);

const duration = computed(() => {
    if (props.run.durationSeconds === undefined) return undefined;
    const m = Math.floor(props.run.durationSeconds / 60);
    return m > 0 ? `${m}m ${props.run.durationSeconds % 60}s` : `${props.run.durationSeconds}s`;
});

const jobDuration = (seconds: number | undefined): string | undefined => {
    if (seconds === undefined) return undefined;
    const m = Math.floor(seconds / 60);
    return m > 0 ? `${m}m ${seconds % 60}s` : `${seconds}s`;
};
</script>

<template>
    <div
        class="group border-l-[3px] transition-colors"
        :class="[borderColor, expanded ? `bg-content/[0.02]` : `hover:bg-content/[0.02]`]"
    >
        <!-- Run header row -->
        <div class="flex w-full items-center gap-3 px-4 py-3">
            <!-- Status icon -->
            <div class="flex shrink-0 items-center">
                <Icon
                    :name="statusIcon(run.status)"
                    class="text-base"
                    :class="[
                        run.status === `success` ? `text-success` : ``,
                        run.status === `failed` ? `text-danger` : ``,
                        run.status === `running` ? `text-info animate-spin` : ``,
                        run.status === `canceled` || run.status === `skipped` ? `text-subtle` : ``,
                    ]"
                />
            </div>

            <!-- Pipeline info -->
            <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <a
                        :href="run.url"
                        target="_blank"
                        rel="noopener"
                        class="truncate text-sm font-medium text-content hover:text-link"
                    >
                        {{ run.title ?? `${run.branch} @ ${run.sha.slice(0, 7)}` }}
                    </a>
                    <StatusBadge :variant="statusVariant(run.status)" :label="statusLabel(run.status)" size="xs" />
                </div>
                <div class="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-subtle">
                    <span class="inline-flex items-center gap-1">
                        <Icon name="code" class="text-2xs" />
                        <span class="font-mono">{{ run.branch }}</span>
                    </span>
                    <span class="font-mono text-subtle/70">{{ run.sha.slice(0, 7) }}</span>
                    <span v-if="duration" class="inline-flex items-center gap-1">
                        <Icon name="clock" class="text-2xs" />
                        {{ duration }}
                    </span>
                </div>
            </div>

            <!-- Inline pipeline graph (stages column) -->
            <div class="flex shrink-0 items-center">
                <PipelineGraph v-if="jobs.length > 0" :jobs="jobs" />
                <div v-else-if="jobsLoading" class="flex items-center gap-1">
                    <span v-for="i in 3" :key="i" class="h-5 w-5 animate-pulse rounded-full bg-subtle/10"></span>
                </div>
            </div>

            <!-- Right side: time + actions -->
            <div class="flex shrink-0 items-center gap-2">
                <span class="text-2xs text-subtle" :title="new Date(run.createdAt).toLocaleString()">
                    {{ timeAgo(run.createdAt) }}
                </span>
                <div class="flex items-center gap-1">
                    <Button
                        v-if="run.status === `failed`"
                        label="Fix with agent"
                        size="small"
                        :loading="busy === actionKey"
                        :disabled="busy !== undefined"
                        @click="emit(`fix`, run)"
                    />
                    <Button
                        v-if="run.status === `running`"
                        label="Cancel"
                        size="small"
                        severity="secondary"
                        text
                        :loading="busy === actionKey"
                        :disabled="busy !== undefined"
                        @click="emit(`cancel`, run)"
                    />
                    <Button
                        v-else
                        label="Re-run"
                        size="small"
                        severity="secondary"
                        text
                        :loading="busy === actionKey"
                        :disabled="busy !== undefined"
                        @click="emit(`rerun`, run)"
                    />
                </div>
                <button type="button" class="cursor-pointer p-1" @click="expanded = !expanded">
                    <Icon
                        name="chevron-down"
                        class="text-2xs text-subtle transition-transform"
                        :class="expanded ? `rotate-180` : ``"
                    />
                </button>
            </div>
        </div>

        <!-- Expanded job detail panel -->
        <div v-if="expanded" class="border-t border-line px-4 pb-4 pt-3">
            <div v-if="jobsLoading" class="flex items-center gap-2 py-3 text-xs text-muted">
                <Icon name="spinner" class="animate-spin text-sm" />
                Loading jobs...
            </div>

            <div v-else-if="jobs.length > 0">
                <div class="mb-2 text-2xs font-semibold uppercase tracking-wide text-subtle">Pipeline jobs</div>
                <!-- Expanded flow: job cards connected by vertical lines, matching the second screenshot -->
                <div class="flex flex-wrap items-center gap-2">
                    <template v-for="(job, idx) in jobs" :key="job.name">
                        <!-- Connector -->
                        <div v-if="idx > 0" class="flex items-center">
                            <div class="h-px w-4 bg-line"></div>
                            <div class="h-1.5 w-1.5 rounded-full bg-line"></div>
                            <div class="h-px w-4 bg-line"></div>
                        </div>
                        <!-- Job card -->
                        <div
                            class="flex items-center gap-2 rounded-lg border px-3 py-1.5"
                            :class="[
                                job.status === `success` ? `border-success/20 bg-success/5` : ``,
                                job.status === `failed` ? `border-danger/20 bg-danger/5` : ``,
                                job.status === `running` ? `border-info/20 bg-info/5` : ``,
                                job.status === `canceled` || job.status === `skipped` ? `border-line bg-canvas` : ``,
                            ]"
                        >
                            <Icon
                                :name="statusIcon(job.status)"
                                class="text-xs"
                                :class="[
                                    job.status === `success` ? `text-success` : ``,
                                    job.status === `failed` ? `text-danger` : ``,
                                    job.status === `running` ? `text-info animate-spin` : ``,
                                    job.status === `canceled` || job.status === `skipped` ? `text-subtle` : ``,
                                ]"
                            />
                            <span class="text-xs font-medium" :class="job.status === `failed` ? `text-danger` : `text-content`">
                                {{ job.name }}
                            </span>
                            <span v-if="jobDuration(job.durationSeconds)" class="text-2xs text-subtle">
                                {{ jobDuration(job.durationSeconds) }}
                            </span>
                        </div>
                    </template>
                </div>
            </div>

            <div v-else-if="run.failedJobs?.length">
                <div class="mb-2 text-2xs font-semibold uppercase tracking-wide text-subtle">Failed jobs</div>
                <div class="flex flex-wrap gap-1.5">
                    <span
                        v-for="job in run.failedJobs"
                        :key="job"
                        class="inline-flex items-center gap-1 rounded-md border border-danger/20 bg-danger/5 px-2 py-1 text-xs font-medium text-danger"
                    >
                        <Icon name="exclamation-circle" class="text-2xs" />
                        {{ job }}
                    </span>
                </div>
            </div>

            <p v-else class="py-2 text-xs text-muted">No job details available for this run.</p>
        </div>
    </div>
</template>
