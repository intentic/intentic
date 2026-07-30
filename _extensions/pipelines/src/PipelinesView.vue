<script setup lang="ts">
import type { CiRepo, PipelineRun } from "@intentic/sandbox-contract";
import { cmp, Icon, InfoHint, Page, PageHeader, ProgressRing, RowGroup } from "@intentic/extension-ui";
import { computed, onMounted, ref } from "vue";
import { markPipelinesSeen } from "./ciAttention";
import { useFailureHistory } from "./useFailureHistory";
import PipelineRunRow from "./PipelineRunRow.vue";
import { host } from "./host";
import { usePipelines } from "./usePipelines";

/* Pipelines redesign: a DevOps-grade CI dashboard. Summary counts up top, grouped by repo, each row
 * auto-fetches its jobs and renders an inline GitLab-style connected-circles pipeline graph. Clicking
 * a stage circle pops over job details; clicking the chevron expands a full horizontal job flow. */

const { repos, runs, error, isLoading, rerun, cancel, fix } = usePipelines();

// Opening the view IS reading it: stamp read state so the rail stops flagging breakages now on screen. Only
// on mount — re-stamping as runs stream in would swallow a failure that lands while the tab sits in the
// background, which is exactly the one the badge exists for.
onMounted(() => void markPipelinesSeen());

// Which jobs keep breaking — free of extra requests, since the rows already load these same job lists.
const { recurring } = useFailureHistory(runs);
// job name → how many runs it has been failing, for the branch a given row belongs to.
const recurringByBranch = computed(() => {
    const map = new Map<string, Map<string, number>>();
    for (const item of recurring.value) {
        const key = `${item.repo}\n${item.branch}`;
        const jobs = map.get(key) ?? new Map<string, number>();
        jobs.set(item.job, item.runs);
        map.set(key, jobs);
    }
    return map;
});
const recurringFor = (run: PipelineRun): ReadonlyMap<string, number> => recurringByBranch.value.get(`${run.repo}\n${run.branch}`) ?? new Map();

const byRepo = computed(() => {
    const groups = new Map<string, PipelineRun[]>();
    for (const run of runs.value) {
        groups.set(run.repo, [...(groups.get(run.repo) ?? []), run]);
    }
    return groups;
});
const runsOf = (repo: CiRepo): PipelineRun[] => byRepo.value.get(repo.repo) ?? [];

// ---- summary counts ----
const counts = computed(() => {
    const c = { running: 0, success: 0, failed: 0, other: 0 };
    for (const run of runs.value) {
        if (run.status === `running`) c.running++;
        else if (run.status === `success`) c.success++;
        else if (run.status === `failed`) c.failed++;
        else c.other++;
    }
    return c;
});

const successRate = computed(() => {
    const terminal = runs.value.filter((r) => r.status === `success` || r.status === `failed`);
    if (terminal.length === 0) return undefined;
    return Math.round((terminal.filter((r) => r.status === `success`).length / terminal.length) * 100);
});

// ---- actions ----
const actionKey = (run: PipelineRun): string => `${run.host}:${run.project}:${run.runId}`;
const busy = ref<string | undefined>();
const actionError = ref<string | undefined>();

const act = async (run: PipelineRun, action: typeof rerun | typeof cancel): Promise<void> => {
    busy.value = actionKey(run);
    actionError.value = undefined;
    try {
        await action.mutateAsync(run);
    } catch (failure) {
        actionError.value = failure instanceof Error ? failure.message : String(failure);
    } finally {
        busy.value = undefined;
    }
};

const fixRun = async (run: PipelineRun): Promise<void> => {
    busy.value = actionKey(run);
    actionError.value = undefined;
    try {
        const { conversationId } = await fix.mutateAsync(run);
        host().navigate(`/agents/${conversationId}`);
    } catch (failure) {
        actionError.value = failure instanceof Error ? failure.message : String(failure);
    } finally {
        busy.value = undefined;
    }
};
</script>

<template>
    <div class="h-full min-h-0 overflow-auto">
        <Page width="wide">
            <PageHeader title="Pipelines" description="CI runs on your workspace repos' GitHub and GitLab remotes.">
                <template #info>
                    <InfoHint label="Pipelines">
                        <span class="block text-sm font-medium text-content">Pipelines</span>
                        <span class="mt-1 block text-xs text-muted">
                            Every workspace repo whose remote lands on a connected GitHub/GitLab account is watched: completed pipelines arrive over a
                            webhook, can wake <b>CI automations</b> (see Automations), and land here. <b>Fix with agent</b> opens an isolated agent
                            conversation seeded with the failed jobs' logs. Each row's circles are its stages — click one for that stage's jobs, or
                            expand the row for the full job graph.
                        </span>
                    </InfoHint>
                </template>
            </PageHeader>

            <div v-if="error" :class="cmp.alertDanger(`mb-4 px-4 py-3 text-sm`)">{{ error }}</div>
            <div v-if="actionError" :class="cmp.alertDanger(`mb-4 px-4 py-3 text-sm`)">{{ actionError }}</div>

            <!-- ---- Summary bar ---- -->
            <div v-if="runs.length > 0" class="mb-5 flex flex-wrap items-center gap-3">
                <div class="flex items-center gap-4 rounded-lg border border-line bg-card px-4 py-2.5">
                    <div v-if="counts.failed > 0" class="flex items-center gap-1.5">
                        <span class="h-2 w-2 rounded-full bg-danger"></span>
                        <span class="text-sm font-semibold text-danger">{{ counts.failed }}</span>
                        <span class="text-xs text-muted">failed</span>
                    </div>
                    <div v-if="counts.running > 0" class="flex items-center gap-1.5">
                        <span class="h-2 w-2 animate-pulse rounded-full bg-info"></span>
                        <span class="text-sm font-semibold text-info">{{ counts.running }}</span>
                        <span class="text-xs text-muted">running</span>
                    </div>
                    <div class="flex items-center gap-1.5">
                        <span class="h-2 w-2 rounded-full bg-success"></span>
                        <span class="text-sm font-semibold text-success">{{ counts.success }}</span>
                        <span class="text-xs text-muted">passed</span>
                    </div>
                    <div v-if="counts.other > 0" class="flex items-center gap-1.5">
                        <span class="h-2 w-2 rounded-full bg-subtle"></span>
                        <span class="text-sm font-semibold text-subtle">{{ counts.other }}</span>
                        <span class="text-xs text-muted">other</span>
                    </div>
                </div>
                <div v-if="successRate !== undefined" class="flex items-center gap-2">
                    <ProgressRing :value="successRate" :size="20" :stroke="2.5" :class="successRate >= 80 ? `text-success` : successRate >= 50 ? `text-warning` : `text-danger`" />
                    <span class="text-xs text-muted">{{ successRate }}% pass rate</span>
                </div>
            </div>

            <!-- ---- What keeps breaking ----
                 Above the runs on purpose: on a repo that fails often the list answers "did it fail" (yes,
                 again), while the thing worth acting on is WHICH job has been failing all along. -->
            <div v-if="recurring.length > 0" class="mb-5 rounded-lg border border-danger/20 bg-danger/5 px-4 py-3">
                <div class="flex items-center gap-2">
                    <Icon name="exclamation-circle" class="text-sm text-danger" />
                    <span class="text-sm font-semibold text-content">Failing repeatedly</span>
                </div>
                <div class="mt-2 flex flex-wrap gap-1.5">
                    <span
                        v-for="item in recurring"
                        :key="`${item.repo}:${item.branch}:${item.job}`"
                        class="inline-flex items-center gap-1.5 rounded-md border border-danger/20 bg-canvas px-2 py-1 text-xs"
                        v-tooltip.top="`${item.job} has failed the last ${item.runs} runs on ${item.repo} ${item.branch}`"
                    >
                        <span class="font-medium text-danger">{{ item.job }}</span>
                        <span class="text-2xs text-subtle">{{ item.runs }} runs</span>
                    </span>
                </div>
            </div>

            <!-- ---- Per-repo sections ---- -->
            <div class="flex flex-col gap-6">
                <RowGroup v-for="repo in repos" :key="repo.repo" :label="repo.repo">
                    <template #info>
                        <div class="flex items-center gap-1.5">
                            <Icon :name="repo.host === `github` ? `github` : `gitlab`" class="text-subtle" />
                            <a :href="repo.url" target="_blank" rel="noopener" class="truncate font-mono text-2xs text-subtle hover:text-link">
                                {{ repo.project }}
                            </a>
                        </div>
                    </template>

                    <div v-if="repo.hookWarning" :class="cmp.alertWarning(`px-4 py-2.5 text-xs break-words`)">{{ repo.hookWarning }}</div>

                    <PipelineRunRow
                        v-for="run in runsOf(repo)"
                        :key="actionKey(run)"
                        :run="run"
                        :busy="busy"
                        :recurring="recurringFor(run)"
                        @rerun="act($event, rerun)"
                        @cancel="act($event, cancel)"
                        @fix="fixRun($event)"
                    />

                    <p v-if="runsOf(repo).length === 0 && !isLoading" class="py-4 text-center text-sm text-muted">No runs yet for this repo.</p>
                </RowGroup>

                <p v-if="repos.length === 0 && !isLoading" class="py-8 text-center text-sm text-muted">
                    No workspace repo maps to a connected GitHub/GitLab account — clone a repo from your connected host, or connect the matching
                    capability on the + page.
                </p>
            </div>
        </Page>
    </div>
</template>
