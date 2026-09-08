<script setup lang="ts">
import { errorMessage } from "@intentic/base/errors";
import type { CiRepo, PipelineRun } from "@intentic/sandbox-contract";
import type { CiFix } from "./ciFixes";
import {
    Icon,
    Notice,
    noticeOf,
    PageAction,
    Picker,
    type PickerOption,
    type PickerOptions,
    RowGroup,
    SplitView,
    useNarrow,
    type AgentRunChoice,
    type TallyItem,
} from "@intentic/extension-ui";
import { computed, ref } from "vue";
import { branchFixes, branchKey, fixesByRun } from "./ciFixes";
import { arrivesOpen, openFailures, supersededBy } from "./ciStreaks";
import { useCiFixes } from "./useCiFixes";
import { useFailureHistory } from "./useFailureHistory";
import PipelineRunRow from "./PipelineRunRow.vue";
import PipelinesSkeleton from "./PipelinesSkeleton.vue";
import PipelinesTally from "./PipelinesTally.vue";
import { type RepoStanding, repoStandings, standingNote } from "./repoStandings";
import { host } from "./host";
import { usePipelines } from "./usePipelines";

// A DevOps-grade CI dashboard: a top-bar picker scopes the board to one repository or all of them, counts ride the
// title row, runs group by repo, and each row auto-fetches its jobs and renders an inline connected-circles graph. A
// stage circle pops job details; the chevron expands the full job flow.

const api = host();
const { repos, runs, error, isPending, rerun, cancel, fix } = usePipelines();

// Repository scope lives in the URL query, not a mirrored ref, so it's linkable and Back/Forward work. A repo the
// workspace no longer maps resolves against current standings and falls back to the whole board.
const standings = computed(() => repoStandings(repos.value, runs.value));
const scope = computed(() => standings.value.find((standing) => standing.repo.repo === api.route.query()[`repo`]));
const scopeRepo = computed<string | undefined>({
    get: () => scope.value?.repo.repo,
    set: (value) => api.route.setQuery({ repo: value }),
});

// Under 'all repositories', a runless repo with no hook warning is dropped from the body (rail row only); one with a
// warning stays, to explain the silence. Scoping to one repository always shows it, empty state included.
const sections = computed(() => (scope.value === undefined ? standings.value.filter((standing) => !standing.silent) : [scope.value]));
const scopedRuns = computed<readonly PipelineRun[]>(() => (scope.value === undefined ? runs.value : scope.value.runs));

// Repository choice lives in the top bar, not a rail column, so the wide job-graph body isn't squeezed by permanent
// chrome. The failing-branch count survives as the picker row's own annotation.
const ALL_REPOS = ``;

const repoOption = (standing: RepoStanding): PickerOption => ({
    value: standing.repo.repo,
    label: standing.repo.repo,
    // Vendor glyph, not a folder: the host decides where runs come from and where 'open pipelines' lands.
    icon: standing.repo.host,
    // Full standing, not just a count; `standingNote` leads with failing branches, the part truncation keeps.
    description: standingNote(standing),
    mono: true,
});

const repoOptions = computed<PickerOptions>(() => {
    const reporting = standings.value.filter((standing) => !standing.silent);
    const silent = standings.value.filter((standing) => standing.silent);
    const failing = standings.value.reduce((sum, standing) => sum + standing.failing, 0);
    const everywhere = failing === 0 ? `Nothing failing` : `${failing} branch${failing === 1 ? `` : `es`} failing`;
    return [
        { options: [{ value: ALL_REPOS, label: `All repositories`, icon: `bolt`, description: everywhere }] },
        ...(reporting.length > 0 ? [{ options: reporting.map(repoOption) }] : []),
        ...(silent.length > 0 ? [{ label: `No runs yet`, options: silent.map(repoOption) }] : []),
    ];
});

// Which jobs keep breaking; no extra requests, the rows already load these same job lists.
const { recurring } = useFailureHistory(scopedRuns);
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

// Which red rows still carry an open problem, so only one gets a primary 'Fix with agent' per breakage. Read off every
// run, not the scoped ones: a branch's history doesn't change with the repository filter.
const open = computed(() => openFailures(runs.value));
const superseded = computed(() => supersededBy(runs.value));

// Which red rows already have an agent, and its fate; read off every run for the same cross-run reason as above. Joined
// by the derived conversation id (ciFixes.ts); only fetched when a run has actually failed.
const anyFailed = computed(() => runs.value.some((run) => run.status === `failed`));
const { fixes, invalidate: refreshFixes } = useCiFixes(anyFailed);
const fixByRun = computed(() => fixesByRun(runs.value, fixes.value));
// Branch's fix, for rows with none of their own; stops the newest red row offering a second agent.
const fixByBranch = computed(() => branchFixes(fixByRun.value));
// A row with its own agent never also carries the branch pointer to itself.
const branchFixFor = (run: PipelineRun): CiFix | undefined => (fixByRun.value.has(run) ? undefined : fixByBranch.value.get(branchKey(run)));

// Rows that default open: a branch's newest commit still running, or a failure it left open (`arrivesOpen`). Off every
// run, not the scoped ones, for the same cross-repo reason as `open`.
const autoOpen = computed(() => arrivesOpen(runs.value));

// One link per repo, pointed at its pipeline list, not the vendor's front door or the project page. Completes a ladder:
// one run's URL, this repo's pipelines, the repo itself (the group's #info line).
const ciUrl = (repo: CiRepo): string => (repo.host === `github` ? `${repo.url}/actions` : `${repo.url}/-/pipelines`);

// Summary counts, worst first; `passed` renders even at zero, or a fully quiet board reads as broken rather than quiet.
const counts = computed<TallyItem[]>(() => {
    const c = { queued: 0, running: 0, success: 0, failed: 0, other: 0 };
    for (const run of scopedRuns.value) {
        if (run.status === `queued`) {
            c.queued++;
        } else if (run.status === `running`) {
            c.running++;
        } else if (run.status === `success`) {
            c.success++;
        } else if (run.status === `failed`) {
            c.failed++;
        } else {
            c.other++;
        }
    }
    return [
        { label: `failed`, value: c.failed, variant: `danger` },
        { label: `running`, value: c.running, variant: `info` },
        // Kept separate from `running`: '4 running' must never silently include queued work. Zero shows no chip.
        { label: `queued`, value: c.queued, variant: `neutral` },
        { label: `passed`, value: c.success, variant: `success`, always: true },
        { label: `other`, value: c.other, variant: `neutral` },
    ];
});

const successRate = computed(() => {
    const terminal = scopedRuns.value.filter((r) => r.status === `success` || r.status === `failed`);
    if (terminal.length === 0) {
        return undefined;
    }
    return Math.round((terminal.filter((r) => r.status === `success`).length / terminal.length) * 100);
});

// On the title row when the pane fits title, counts, rate and picker together (44rem, the width <SplitView> folds at);
// narrower, it moves above the list. Measured off the body, not the window: the body is what a ref can reach.
const TALLY_AT_REM = 44;
const body = ref<HTMLElement | undefined>(undefined);
const narrowBoard = useNarrow(body, TALLY_AT_REM);
// Hidden when there are no runs at all; the body's own empty-state sentence is the whole answer.
const showTally = computed(() => isPending.value || scopedRuns.value.length > 0);

const actionKey = (run: PipelineRun): string => `${run.host}:${run.project}:${run.runId}`;
const busy = ref<string | undefined>();
const actionError = ref<string | undefined>();

const act = async (run: PipelineRun, action: typeof rerun | typeof cancel): Promise<void> => {
    busy.value = actionKey(run);
    actionError.value = undefined;
    try {
        await action.mutateAsync(run);
    } catch (failure) {
        actionError.value = errorMessage(failure);
    } finally {
        busy.value = undefined;
    }
};

// `pick` is set only via the caret beside the row's button; the ordinary path opens on the sandbox's agent-run list.
const fixRun = async (run: PipelineRun, pick: AgentRunChoice | undefined): Promise<void> => {
    busy.value = actionKey(run);
    actionError.value = undefined;
    try {
        const { conversationId } = await fix.mutateAsync({ run, pick });
        // Not awaited: navigation below is the point, so the row shows 'Agent working' without delaying it.
        void refreshFixes();
        // Opens the fleet board, not the diff view: nothing to review yet. `?focus` waits for the roster.
        api.navigate(`/agents?focus=${encodeURIComponent(conversationId)}`);
    } catch (failure) {
        actionError.value = errorMessage(failure);
    } finally {
        busy.value = undefined;
    }
};
</script>

<template>
    <!-- `scroll="page"`: this body is a report read top-down once, not a document paired with an index worth preserving position in. -->
    <SplitView title="Pipelines" scroll="page" :scroll-key="scopeRepo">
        <!--
            In #info, not beside the picker in #actions: a fact, not a control, and the action cluster is `shrink-0`, so a tally there would push the
            verbs off instead of wrapping.
        -->
        <template #info>
            <!--
                `min-w-0 flex-1`: the tally is what gives here. Sized from content it would squeeze the h1's own title; zero-basis instead, it wraps
                a count onto a second line first.
            -->
            <PipelinesTally v-if="showTally && !narrowBoard" :items="counts" :rate="successRate" :skeleton="isPending" class="ml-1 min-w-0 flex-1" />
        </template>

        <template #actions>
            <!-- Only where there's a choice: over one repository this would point at the only thing on screen. -->
            <Picker
                v-if="repos.length > 1"
                :model-value="scopeRepo ?? ALL_REPOS"
                :options="repoOptions"
                variant="ghost"
                aria-label="Repository"
                placeholder="Repository"
                @update:model-value="(next) => (scopeRepo = next === ALL_REPOS ? undefined : next)"
            />
            <!-- No `hint`: the glyph already names the vendor, the label already names the project. -->
            <PageAction
                v-for="standing in sections"
                :key="standing.repo.repo"
                :icon="standing.repo.host"
                :label="`Open ${standing.repo.project} pipelines`"
                :href="ciUrl(standing.repo)"
            />
        </template>

        <template #strips>
            <Notice v-if="error" :of="noticeOf(error)" />
            <Notice v-if="actionError" :of="noticeOf(actionError)" />
        </template>

        <template #detail>
            <!--
                No scroller or `min-h-0 flex-1`: nothing clamps this, so the column is as tall as its runs. The measured element: its width matches
                the header's, and it's the one a `ref` can reach.
            -->
            <div ref="body" class="flex flex-col">
                <!-- Too narrow for the header: the orientation line moves above the list, ahead of the skeleton, so the wait and the board match. -->
                <PipelinesTally v-if="showTally && narrowBoard" :items="counts" :rate="successRate" :skeleton="isPending" class="mb-5" />

                <!--
                    Also covers the window before the sandbox handshake unblocks the fetch. Shows the board's shape, not a page indistinguishable
                    from 'no repos connected'.
                -->
                <PipelinesSkeleton v-if="isPending" />

                <template v-else>
                    <!-- Above the runs on purpose: the list says a repo failed again; this says which job keeps failing. -->
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

                    <!-- Per-repo sections, worst first. -->
                    <div class="flex flex-col gap-6">
                        <RowGroup v-for="standing in sections" :key="standing.repo.repo" :label="standing.repo.repo">
                            <template #info>
                                <!--
                                    Links to the repo itself, not its pipelines (the header action's rung); text and destination agree, both name the
                                    project.
                                -->
                                <a
                                    :href="standing.repo.url"
                                    target="_blank"
                                    rel="noopener"
                                    class="touch-target flex items-center gap-1.5 text-subtle hover:text-link"
                                    v-tooltip.top="`Open ${standing.repo.project} on ${standing.repo.host === `github` ? `GitHub` : `GitLab`}`"
                                >
                                    <Icon :name="standing.repo.host" />
                                    <span class="truncate font-mono text-2xs">{{ standing.repo.project }}</span>
                                </a>
                            </template>

                            <!--
                                Warning text is for everyone; the recipe (URL + signing secret) is attached only for a maintainer or the owner, so it
                                renders only when present.
                            -->
                            <Notice v-if="standing.repo.hookWarning" tone="warning" class="px-4 py-2.5 break-words">
                                {{ standing.repo.hookWarning }}
                                <template v-if="standing.repo.hookRecipe"> {{ standing.repo.hookRecipe }}</template>
                            </Notice>

                            <PipelineRunRow
                                v-for="run in standing.runs"
                                :key="actionKey(run)"
                                :run="run"
                                :busy="busy"
                                :recurring="recurringFor(run)"
                                :open="open.has(run)"
                                :superseded="superseded.get(run)"
                                :auto-open="autoOpen.has(run)"
                                :fix="fixByRun.get(run)"
                                :branch-fix="branchFixFor(run)"
                                @rerun="act($event, rerun)"
                                @cancel="act($event, cancel)"
                                @fix="fixRun"
                            />

                            <p v-if="standing.runs.length === 0" class="py-4 text-center text-sm text-muted">No runs yet for this repo.</p>
                        </RowGroup>

                        <p v-if="repos.length === 0" class="py-8 text-center text-sm text-muted">
                            No workspace repo maps to a connected GitHub/GitLab account: clone a repo from your connected host, or connect the
                            matching capability on the + page.
                        </p>

                        <!-- Every connected repo is silent; distinct from 'nothing is connected' and must not read like it. -->
                        <p v-else-if="sections.length === 0" class="py-8 text-center text-sm text-muted">
                            No pipeline has run yet on {{ repos.length === 1 ? `this repo` : `any of the ${repos.length} connected repos` }}. Runs
                            land here as soon as one does.
                        </p>
                    </div>
                </template>
            </div>
        </template>
    </SplitView>
</template>
