<script setup lang="ts">
import type { CiRepo, PipelineRun } from "@intentic/sandbox-contract";
import { Button, Card, cmp, Icon, InfoHint, Page, PageHeader, StatusBadge, type StatusVariant, timeAgo } from "@intentic/extension-ui";
import { computed, ref } from "vue";
import { host } from "./host";
import { usePipelines } from "./usePipelines";

/* The pipelines extension: recent CI runs across every workspace repo whose remote lands on a connected
 * github/gitlab account, grouped by repo. Freshness rides the daemon's webhook cache (30s polls only re-read
 * that cache). Row actions: re-run / cancel proxy to the vendor; "Fix with agent" opens an isolated
 * conversation seeded with the failure context and jumps to its fleet card. A repo whose webhook could not be
 * registered renders the daemon's warning inline — the manual recipe with the URL + secret to paste. */

const { repos, runs, error, isLoading, rerun, cancel, fix } = usePipelines();

const byRepo = computed(() => {
    const groups = new Map<string, PipelineRun[]>();
    for (const run of runs.value) {
        groups.set(run.repo, [...(groups.get(run.repo) ?? []), run]);
    }
    return groups;
});
const runsOf = (repo: CiRepo): PipelineRun[] => byRepo.value.get(repo.repo) ?? [];

const statusVariant = (status: PipelineRun[`status`]): StatusVariant =>
    status === `success` ? `success` : status === `failed` ? `danger` : status === `running` ? `info` : `neutral`;
const statusLabel = (status: PipelineRun[`status`]): string =>
    status === `success`
        ? `Passed`
        : status === `failed`
          ? `Failed`
          : status === `running`
            ? `Running`
            : status === `canceled`
              ? `Canceled`
              : `Skipped`;

const duration = (run: PipelineRun): string | undefined => {
    if (run.durationSeconds === undefined) {
        return undefined;
    }
    const minutes = Math.floor(run.durationSeconds / 60);
    return minutes > 0 ? `${minutes}m ${run.durationSeconds % 60}s` : `${run.durationSeconds}s`;
};

// One in-flight action at a time, keyed so exactly the clicked row spins.
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
// Fix lands on the fleet: the conversation is the deliverable, so go where it lives.
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
                            conversation seeded with the failed jobs' logs.
                        </span>
                    </InfoHint>
                </template>
            </PageHeader>

            <div v-if="error" :class="cmp.alertDanger(`mb-4 px-4 py-3 text-sm`)">{{ error }}</div>
            <div v-if="actionError" :class="cmp.alertDanger(`mb-4 px-4 py-3 text-sm`)">{{ actionError }}</div>

            <div class="flex flex-col gap-4">
                <section v-for="repo in repos" :key="repo.repo" class="rounded-lg border border-line bg-card p-4">
                    <div class="mb-3 flex flex-wrap items-center gap-2">
                        <Icon :name="repo.host === `github` ? `github` : `gitlab`" class="text-subtle" />
                        <h3 :class="cmp.sectionLabel()">{{ repo.repo }}</h3>
                        <a :href="repo.url" target="_blank" rel="noopener" class="truncate font-mono text-2xs text-subtle hover:text-link">
                            {{ repo.project }}
                        </a>
                    </div>

                    <div v-if="repo.hookWarning" :class="cmp.alertWarning(`mb-3 px-3 py-2 text-xs break-words`)">{{ repo.hookWarning }}</div>

                    <div class="flex flex-col divide-y divide-line">
                        <div v-for="run in runsOf(repo)" :key="actionKey(run)" class="flex items-center gap-3 py-2.5">
                            <StatusBadge :variant="statusVariant(run.status)" :label="statusLabel(run.status)" size="xs" dot class="shrink-0" />
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
                                    <span class="font-mono text-2xs text-subtle">{{ run.branch }}</span>
                                    <span class="font-mono text-2xs text-subtle/70">{{ run.sha.slice(0, 7) }}</span>
                                    <span v-if="duration(run)" class="text-2xs text-subtle">{{ duration(run) }}</span>
                                </div>
                                <p v-if="run.failedJobs?.length" class="mt-0.5 truncate text-xs text-danger">
                                    failed: {{ run.failedJobs.join(`, `) }}
                                </p>
                            </div>
                            <span class="shrink-0 text-2xs text-subtle" :title="new Date(run.createdAt).toLocaleString()">
                                {{ timeAgo(run.createdAt) }}
                            </span>
                            <div class="flex shrink-0 items-center gap-1">
                                <Button
                                    v-if="run.status === `failed`"
                                    label="Fix with agent"
                                    size="small"
                                    :loading="busy === actionKey(run)"
                                    :disabled="busy !== undefined"
                                    @click="fixRun(run)"
                                />
                                <Button
                                    v-if="run.status === `running`"
                                    label="Cancel"
                                    size="small"
                                    severity="secondary"
                                    text
                                    :loading="busy === actionKey(run)"
                                    :disabled="busy !== undefined"
                                    @click="act(run, cancel)"
                                />
                                <Button
                                    v-else
                                    label="Re-run"
                                    size="small"
                                    severity="secondary"
                                    text
                                    :loading="busy === actionKey(run)"
                                    :disabled="busy !== undefined"
                                    @click="act(run, rerun)"
                                />
                            </div>
                        </div>
                        <p v-if="runsOf(repo).length === 0 && !isLoading" class="py-4 text-center text-sm text-muted">No runs yet for this repo.</p>
                    </div>
                </section>

                <p v-if="repos.length === 0 && !isLoading" class="py-8 text-center text-sm text-muted">
                    No workspace repo maps to a connected GitHub/GitLab account — clone a repo from your connected host, or connect the matching
                    capability on the + page.
                </p>
            </div>
        </Page>
    </div>
</template>
