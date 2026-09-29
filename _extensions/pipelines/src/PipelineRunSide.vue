<script setup lang="ts">
import type { SideViewInput } from "@intentic/extension-api";
import { formatTimestamp, Icon, StatusBadge, timeAgo, ui, useNarrow } from "@intentic/extension-ui";
import { computed, ref } from "vue";
import PipelineDagGraph from "./graph/PipelineDagGraph.vue";
import { pipelineStages } from "./graph/pipelineDag";
import { forgeRunUrl, runOf, runRefOf } from "./runSide";
import { formatDuration, STATUS_TONE } from "./statusVisual";
import { useFailureHistory } from "./useFailureHistory";
import { usePipelines } from "./usePipelines";
import { useRunJobs } from "./useRunJobs";
import { t } from "./i18n.js";

// One CI run beside whatever the reader is doing (a chat about the failure, the fix agent's own conversation): its state,
// its job graph, and what failed. A look, not the board: re-running, cancelling and fixing stay on Pipelines, which the
// side panel's "Open in Pipelines" moves to.

const { input } = defineProps<{ input: SideViewInput }>();

const { runs, repos } = usePipelines();
const runRef = computed(() => runRefOf(input));
const run = computed(() => (runRef.value === undefined ? undefined : runOf({ runs: runs.value, repos: repos.value }, runRef.value)));
const repo = computed(() => repos.value.find((entry) => entry.repo === runRef.value?.repo));
const page = computed(() => (runRef.value === undefined ? undefined : forgeRunUrl(runRef.value, run.value, repo.value)));

// The same job list and read the board's row makes, so the two never disagree and share one cache entry.
const { jobs, isLoading: jobsLoading } = useRunJobs(run);
const stages = computed(() => pipelineStages(jobs.value));

// Which of its jobs keep failing on this branch, as the board marks them; only this branch's runs are read for it.
const branchRuns = computed(() => runs.value.filter((other) => other.repo === run.value?.repo && other.branch === run.value.branch));
const { recurring } = useFailureHistory(branchRuns);
const recurringJobs = computed(() => new Map(recurring.value.filter((item) => item.repo === run.value?.repo && item.branch === run.value.branch).map((item) => [item.job, item.runs])));

// A side panel is a column: the stages run down it rather than across, until it is dragged wide enough for a row.
const graphBox = ref<HTMLElement>();
const narrow = useNarrow(graphBox, 36);

const tone = computed(() => (run.value === undefined ? undefined : STATUS_TONE[run.value.status]));
const duration = computed(() => formatDuration(run.value?.durationSeconds));
const forgeName = computed(() => (repo.value?.host === `gitlab` ? `GitLab` : `GitHub`));
</script>

<template>
    <div class="flex min-h-0 flex-1 flex-col bg-canvas">
        <!-- Which run, and how it went: enough to decide whether to look closer, in two short lines. -->
        <div v-if="run !== undefined && tone !== undefined" class="flex shrink-0 flex-col gap-1 border-b border-line bg-card px-3 py-2">
            <div class="flex min-w-0 items-center gap-2">
                <StatusBadge :variant="tone.variant" :label="tone.label" size="xs" />
                <span class="min-w-0 flex-1 truncate text-xs font-medium text-content" v-tooltip.bottom.overflow="run.title ?? `#${run.runId}`">
                    {{ run.title ?? `#${run.runId}` }}
                </span>
                <a
                    v-if="page !== undefined"
                    :href="page"
                    target="_blank"
                    rel="noopener"
                    :class="ui.iconButton(`h-7 w-7 shrink-0 rounded`)"
                    :aria-label="t(`runSide.openOn`, { forge: forgeName })"
                    v-tooltip.bottom="t(`runSide.openOn`, { forge: forgeName })"
                >
                    <Icon name="arrow-up-right" class="text-xs" />
                </a>
            </div>
            <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-subtle">
                <span v-if="run.workflow !== undefined" class="truncate">{{ run.workflow }}</span>
                <span class="inline-flex min-w-0 items-center gap-1 font-mono"><Icon name="fork" class="text-2xs" /><span class="truncate">{{ run.branch }}</span></span>
                <span class="font-mono">{{ run.sha.slice(0, 7) }}</span>
                <span v-tooltip.bottom="formatTimestamp(run.createdAt)">{{ timeAgo(run.createdAt) }}</span>
                <span v-if="duration !== undefined">{{ duration }}</span>
            </div>
        </div>

        <div ref="graphBox" class="relative flex min-h-0 flex-1 flex-col">
            <div v-if="runRef === undefined" class="flex flex-1 items-center justify-center px-6 text-center text-xs text-muted">
                {{ t(`runSide.unreadable`) }}
            </div>
            <!-- Older than the list the sandbox keeps, or not read yet: the forge still has it. -->
            <div v-else-if="run === undefined" class="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
                <Icon name="pipelines" class="text-2xl text-subtle" />
                <p class="text-xs text-muted">{{ t(`runSide.notListed`, { number: runRef.runId, repo: runRef.repo }) }}</p>
                <a v-if="page !== undefined" :href="page" target="_blank" rel="noopener" :class="ui.linkButton(`text-xs`)">
                    {{ t(`runSide.openOn`, { forge: forgeName }) }}
                </a>
            </div>
            <div v-else-if="jobsLoading" class="flex flex-1 items-center justify-center" role="status" aria-busy="true" :aria-label="t(`pipelineRunRow.loadingJobs`)">
                <Icon name="spinner" spin class="text-xl text-subtle" aria-hidden="true" />
            </div>
            <!-- The whole graph, given the tab: pan and zoom inside it rather than a band cropped to a row. -->
            <PipelineDagGraph v-else-if="stages.length > 0" :stages="stages" :recurring="recurringJobs" fill :direction="narrow ? `TB` : `LR`" />
            <div v-else-if="run.failedJobs?.length" class="flex flex-col gap-2 p-3">
                <div :class="ui.sectionLabelSm()">{{ t(`pipelineRunRow.failedJobs`) }}</div>
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
            <p v-else class="p-3 text-xs text-muted">{{ t(`pipelineRunRow.noJobDetailsAvailable`) }}</p>
        </div>
    </div>
</template>
