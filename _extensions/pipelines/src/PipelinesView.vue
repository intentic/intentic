<script setup lang="ts">
import type { CiRepo, PipelineRun } from "@intentic/sandbox-contract";
import {
    StatusTally,
    Icon,
    InfoHint,
    Notice,
    noticeOf,
    PageAction,
    ProgressRing,
    RowGroup,
    SplitView,
    type AgentRunChoice,
    type TallyItem,
} from "@intentic/extension-ui";
import { computed, onMounted, ref } from "vue";
import { markPipelinesSeen } from "./ciAttention";
import { openFailures, supersededBy } from "./ciStreaks";
import { useFailureHistory } from "./useFailureHistory";
import PipelineRunRow from "./PipelineRunRow.vue";
import PipelinesSkeleton from "./PipelinesSkeleton.vue";
import RepoRail from "./RepoRail.vue";
import { repoStandings } from "./repoStandings";
import { host } from "./host";
import { usePipelines } from "./usePipelines";

/* Pipelines: a DevOps-grade CI dashboard. A rail scopes the board to one repository or to all of them, summary
 * counts sit above the list, runs are grouped by repo, and each row auto-fetches its jobs and renders an inline
 * GitLab-style connected-circles pipeline graph. Clicking a stage circle pops over job details; clicking the
 * chevron expands a full horizontal job flow. */

const api = host();
const { repos, runs, error, isPending, rerun, cancel, fix } = usePipelines();

// Opening the view IS reading it: stamp read state so the rail stops flagging breakages now on screen. Only
// on mount — re-stamping as runs stream in would swallow a failure that lands while the tab sits in the
// background, which is exactly the one the badge exists for.
onMounted(() => void markPipelinesSeen());

/* WHICH REPOSITORY THE BOARD IS SCOPED TO LIVES IN THE URL, so "is intentic red" is a link somebody can be sent.
 * Derived from the query rather than mirrored into a ref: one direction of flow, and Back/Forward work for free.
 * Absent means every repository, which is why it is `undefined` rather than a sentinel — the tidy URL is the one
 * you get by default.
 *
 * A selection the workspace no longer maps is not a scope. It resolves against the standings rather than being
 * trusted, so a repo that was disconnected since the link was made falls back to the whole board instead of
 * stranding it on a page about nothing. */
const standings = computed(() => repoStandings(repos.value, runs.value));
const scope = computed(() => standings.value.find((standing) => standing.repo.repo === api.route.query()[`repo`]));
const scopeRepo = computed<string | undefined>({
    get: () => scope.value?.repo.repo,
    set: (value) => api.route.setQuery({ repo: value }),
});

/* WHAT THE BOARD SPENDS A CARD ON. Under "all repositories", a repository with no runs and no webhook warning is
 * a rail row and nothing more: it has one sentence to say and it was saying it in a 112px bordered card, four of
 * which filled the whole first screen above the only repository that runs pipelines at all. A hook warning keeps
 * a runless repository in the body on purpose — it is the explanation for the silence, and hiding the answer
 * along with the question is how a board starts lying (repoStandings.ts has the full ranking).
 *
 * Ask for one repository and you get it whatever it has to say, empty state included: that is the answer to the
 * question you just asked, and it is where the "No runs yet" sentence now lives. */
const sections = computed(() => (scope.value === undefined ? standings.value.filter((standing) => !standing.silent) : [scope.value]));
const scopedRuns = computed<readonly PipelineRun[]>(() => (scope.value === undefined ? runs.value : scope.value.runs));

// Which jobs keep breaking — free of extra requests, since the rows already load these same job lists.
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

/* Which red rows still carry an open problem. The list is chronological, so without this every failure ever
 * recorded keeps a primary "Fix with agent" — one branch breakage becomes six identical demands, and the run
 * that broke main an hour ago looks exactly like the one a green run closed yesterday. Same rule the rail badge
 * runs on (ciStreaks), applied to the rows instead of the tile. Read off every run rather than the scoped ones:
 * a branch's history is the same history whichever repository the reader happens to be looking at. */
const open = computed(() => openFailures(runs.value));
const superseded = computed(() => supersededBy(runs.value));

/* THE WAY OUT TO THE VENDOR, per repo, and pointed at PIPELINES rather than at the project.
 *
 * The header action used to be one link per host ORIGIN — github.com, gitlab.com — which is the vendor's
 * front door and a level above everything this page shows. Nobody reading a CI board wants github.com; they
 * want the run list for the repo whose red row they are looking at. So the header carries one link per repo
 * and each lands on that repo's pipeline list, which is the same surface this view is a mirror of.
 *
 * Per repo and not per origin also fixes what the icons could say. Two links to two origins were two copies
 * of one vendor glyph; two links to two repos are told apart by their tooltip, which names the project.
 *
 * One link per repo IN THE BODY, not per repo in the workspace: a repository that has never run anything has an
 * empty page at the far end of that link, and the row of glyphs is the narrowest place on the screen to spend on
 * one. Narrowing the board to a single repository narrows this to a single link, which is the point.
 *
 * The ladder this completes, finest first: one run (PipelineRunRow's run.url) → this repo's pipelines (here)
 * → the repo itself (the group's #info line). Nothing generic at any rung. */
const ciUrl = (repo: CiRepo): string => (repo.host === `github` ? `${repo.url}/actions` : `${repo.url}/-/pipelines`);

// ---- summary counts ----
// Worst first, and `passed` is the one that renders at zero: a board whose whole tally is silent reads as a
// broken view rather than as a quiet one.
const counts = computed<TallyItem[]>(() => {
    const c = { running: 0, success: 0, failed: 0, other: 0 };
    for (const run of scopedRuns.value) {
        if (run.status === `running`) c.running++;
        else if (run.status === `success`) c.success++;
        else if (run.status === `failed`) c.failed++;
        else c.other++;
    }
    return [
        { label: `failed`, value: c.failed, variant: `danger` },
        { label: `running`, value: c.running, variant: `info`, pulse: true },
        { label: `passed`, value: c.success, variant: `success`, always: true },
        { label: `other`, value: c.other, variant: `neutral` },
    ];
});

const successRate = computed(() => {
    const terminal = scopedRuns.value.filter((r) => r.status === `success` || r.status === `failed`);
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

// `pick` is set only when the reader used the caret beside this row's button — otherwise the daemon opens the
// session on the sandbox's agent-run list, which is the ordinary path and the one that stays one click long.
const fixRun = async (run: PipelineRun, pick: AgentRunChoice | undefined): Promise<void> => {
    busy.value = actionKey(run);
    actionError.value = undefined;
    try {
        const { conversationId } = await fix.mutateAsync({ run, pick });
        // The BOARD with the new card focused, not the agent's diff view: the turn started a second ago and has
        // nothing to review yet, so what the user wants is to watch it work beside their other agents. `?focus`
        // is the fleet's own deep link — it waits for the card to reach the roster, then selects and reveals it.
        api.navigate(`/agents?focus=${encodeURIComponent(conversationId)}`);
    } catch (failure) {
        actionError.value = failure instanceof Error ? failure.message : String(failure);
    } finally {
        busy.value = undefined;
    }
};
</script>

<template>
    <SplitView
        title="Pipelines"
        :description="scope === undefined ? `CI runs on your workspace repos' GitHub and GitLab remotes.` : `CI runs on ${scope.repo.project}.`"
    >
        <template #info>
            <InfoHint label="Pipelines">
                <span class="block text-sm font-medium text-content">Pipelines</span>
                <span class="mt-1 block text-xs text-muted">
                    Every workspace repo whose remote lands on a connected GitHub/GitLab account is watched: completed pipelines arrive over a
                    webhook, can wake <b>CI automations</b> (see Automations), and land here. <b>Fix with agent</b> starts an isolated agent seeded
                    with that run's failed jobs' logs and takes you to its card on the Agents board — it stands out on the failure a branch is
                    actually stuck on, and stays quiet on older failures a later green run has already left behind. It opens on the model in Sandbox ▸
                    Agent ▸ Models; the caret beside it runs one fix on something else. Each row's circles are its stages — click one for that stage's
                    jobs, or expand the row for the full job graph.
                </span>
            </InfoHint>
        </template>

        <template #actions>
            <!-- No `hint`: the vendor is what the glyph already says, and the project is what the
                 label already says. A hint here would only be the same fact a third time. -->
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

        <!-- Only where there is a choice to make. An index over one repository is 16rem of chrome pointing at the
             only thing on screen — and unlike Maintenance, whose report always carries the workspace root
             alongside, a workspace with exactly one CI-mapped repo is an ordinary case here. -->
        <template v-if="repos.length > 1" #rail>
            <RepoRail v-model="scopeRepo" :standings="standings" />
        </template>

        <template #detail>
            <div class="scrollbar-thin flex min-h-0 flex-1 flex-col overflow-y-auto">
                <!-- Nothing has come back yet — including the window where the sandbox handshake still gates the
                     fetch. Show the board's shape rather than a bare page that is indistinguishable from "you have
                     no repos connected". -->
                <PipelinesSkeleton v-if="isPending" />

                <template v-else>
                    <!-- ---- Summary bar ---- -->
                    <StatusTally v-if="scopedRuns.length > 0" :items="counts" class="mb-5">
                        <span v-if="successRate !== undefined" class="flex items-center gap-2">
                            <ProgressRing
                                :value="successRate"
                                :size="20"
                                :stroke="2.5"
                                :class="successRate >= 80 ? `text-success` : successRate >= 50 ? `text-warning` : `text-danger`"
                            />
                            <span class="text-xs text-muted">{{ successRate }}% pass rate</span>
                        </span>
                    </StatusTally>

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

                    <!-- ---- Per-repo sections, worst first ---- -->
                    <div class="flex flex-col gap-6">
                        <RowGroup v-for="standing in sections" :key="standing.repo.repo" :label="standing.repo.repo">
                            <template #info>
                                <!-- The REPO itself, not its pipelines — the header action above already owns
                                     that rung, and this line's job is to say which project the group is. Text and
                                     destination agree: the words are the project path, the link is the project. -->
                                <a
                                    :href="standing.repo.url"
                                    target="_blank"
                                    rel="noopener"
                                    class="flex items-center gap-1.5 text-subtle hover:text-link"
                                    v-tooltip.top="`Open ${standing.repo.project} on ${standing.repo.host === `github` ? `GitHub` : `GitLab`}`"
                                >
                                    <Icon :name="standing.repo.host" />
                                    <span class="truncate font-mono text-2xs">{{ standing.repo.project }}</span>
                                </a>
                            </template>

                            <Notice v-if="standing.repo.hookWarning" tone="warning" class="px-4 py-2.5 break-words">
                                {{ standing.repo.hookWarning }}
                            </Notice>

                            <PipelineRunRow
                                v-for="run in standing.runs"
                                :key="actionKey(run)"
                                :run="run"
                                :busy="busy"
                                :recurring="recurringFor(run)"
                                :open="open.has(run)"
                                :superseded="superseded.get(run)"
                                @rerun="act($event, rerun)"
                                @cancel="act($event, cancel)"
                                @fix="fixRun"
                            />

                            <p v-if="standing.runs.length === 0" class="py-4 text-center text-sm text-muted">No runs yet for this repo.</p>
                        </RowGroup>

                        <p v-if="repos.length === 0" class="py-8 text-center text-sm text-muted">
                            No workspace repo maps to a connected GitHub/GitLab account — clone a repo from your connected host, or connect the
                            matching capability on the + page.
                        </p>

                        <!-- Every connected repo is silent, so the body has nothing to group. Not the same page as
                             "nothing is connected", and it must not read like it. -->
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
