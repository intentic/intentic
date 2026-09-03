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

/* Pipelines: a DevOps-grade CI dashboard. A top-bar picker scopes the board to one repository or to all of them,
 * the summary counts ride the title row beside it, runs are grouped by repo, and each row auto-fetches its jobs
 * and renders an inline GitLab-style connected-circles pipeline graph. Clicking a stage circle pops over job
 * details; clicking the chevron expands a full horizontal job flow, which is where the runs on a branch's newest
 * commit start out: the ones still going, and the ones that failed there. */

const api = host();
const { repos, runs, error, isPending, rerun, cancel, fix } = usePipelines();

/* WHICH REPOSITORY THE BOARD IS SCOPED TO LIVES IN THE URL, so "is intentic red" is a link somebody can be sent.
 * Derived from the query rather than mirrored into a ref: one direction of flow, and Back/Forward work for free.
 * Absent means every repository, which is why it is `undefined` rather than a sentinel: the tidy URL is the one
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
 * a runless repository in the body on purpose: it is the explanation for the silence, and hiding the answer
 * along with the question is how a board starts lying (repoStandings.ts has the full ranking).
 *
 * Ask for one repository and you get it whatever it has to say, empty state included: that is the answer to the
 * question you just asked, and it is where the "No runs yet" sentence now lives. */
const sections = computed(() => (scope.value === undefined ? standings.value.filter((standing) => !standing.silent) : [scope.value]));
const scopedRuns = computed<readonly PipelineRun[]>(() => (scope.value === undefined ? runs.value : scope.value.runs));

/* WHICH REPOSITORY THE BOARD SHOWS IS A CHOICE IN THE TOP BAR, not a column down the side of it.
 *
 * It was a 16rem rail listing every repository with a count beside it, on the reasoning that "is anything red
 * anywhere" is the first question a CI board answers and a column of counts answers it at a glance. What that
 * left out is what this board's body actually IS: a run's job graph, drawn left to right, and the widest thing
 * in the app. Sixteen rems of permanent chrome went on a choice made once a session, and the diagram it was
 * taking the width from had to be panned to be read. Documentation picks its repository from the top bar
 * already, so this is the app's one answer to "which repo am I looking at" rather than a second one.
 *
 * Nothing is lost with the column. ONE NUMBER PER ROW, still BROKEN BRANCHES (ciStreaks' rule, so a repository
 * three commits deep in one breakage says one and not three), now the picker row's own annotation, and still
 * absent in the silent group, where "0 failing" would be a claim about a repository nobody has heard from.
 * The sections below are ordered worst-first whatever is picked, and the sidebar badge still says a branch is
 * red wherever you are.
 *
 * The repositories with no runs at all are a LABELLED GROUP at the bottom rather than rows mixed into the list:
 * an empty repository and a healthy one both show nothing, and the heading is what tells them apart. */
const ALL_REPOS = ``;

const repoOption = (standing: RepoStanding): PickerOption => ({
    value: standing.repo.repo,
    label: standing.repo.repo,
    // The vendor glyph rather than a folder: which host a repository is on decides where its runs come from and
    // where "open pipelines" lands, and it is free here, the sections below already carry it.
    icon: standing.repo.host,
    /* The whole standing, not just the count: a picker row has the width for it where a rail row had one number
     * and a tint. `standingNote` leads with the failing branches, which is what makes it safe in a slot that
     * TRUNCATES, the first clause is the one worth reading and it is the one that survives. */
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

// Which jobs keep breaking: free of extra requests, since the rows already load these same job lists.
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
 * recorded keeps a primary "Fix with agent": one branch breakage becomes six identical demands, and the run
 * that broke main an hour ago looks exactly like the one a green run closed yesterday. Same rule the rail badge
 * runs on (ciStreaks), applied to the rows instead of the tile. Read off every run rather than the scoped ones:
 * a branch's history is the same history whichever repository the reader happens to be looking at. */
const open = computed(() => openFailures(runs.value));
const superseded = computed(() => supersededBy(runs.value));

/* WHICH RED ROWS ALREADY HAVE AN AGENT ON THEM, and what became of it.
 *
 * A fourth cross-run fact, read off every run rather than the scoped ones for the same reason the three below
 * are: an agent working on a branch is working on it whichever repository the reader happens to be looking at.
 * The join is the derived conversation id (ciFixes.ts), so this costs one cheap daemon read and no bookkeeping.
 *
 * ASKED FOR ONLY WHEN THERE IS SOMETHING TO ASK ABOUT: no failed run, no fix to find, no request. */
const anyFailed = computed(() => runs.value.some((run) => run.status === `failed`));
const { fixes, invalidate: refreshFixes } = useCiFixes(anyFailed);
const fixByRun = computed(() => fixesByRun(runs.value, fixes.value));
// The branch's ongoing fix, for the rows that have none of their own: a fix is attached to a run, a breakage
// belongs to a branch, and the newest red row is exactly the one that would otherwise offer a second agent for
// work already in flight one row below it.
const fixByBranch = computed(() => branchFixes(fixByRun.value));
// A row with an agent of its own says so itself, and is also the row every OTHER row on the branch is being
// pointed at, so it never carries the pointer.
const branchFixFor = (run: PipelineRun): CiFix | undefined => (fixByRun.value.has(run) ? undefined : fixByBranch.value.get(branchKey(run)));

/* WHICH ROWS ARRIVE OPEN: what the branch's newest commit has to say that is not "fine", its runs still going
 * and the failures it left open (ciStreaks' `arrivesOpen`, which has the reasoning). Reading a board whose live
 * run is a strip of five circles means clicking it to see the graph that is the reason this view exists, and a
 * red row is the same bargain one moment later: what broke is a job in that graph. Off every run rather than the
 * scoped ones, for the same reason `open` is: a branch's head commit is the same commit whichever repository the
 * reader happens to be scoped to. */
const autoOpen = computed(() => arrivesOpen(runs.value));

/* THE WAY OUT TO THE VENDOR, per repo, and pointed at PIPELINES rather than at the project.
 *
 * The header action used to be one link per host ORIGIN: github.com, gitlab.com, which is the vendor's
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
        if (run.status === `running`) {
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

/* WHERE THE TALLY GOES, and it is a measurement rather than a preference.
 *
 * On the TITLE ROW, because the vertical space it was costing is the scarcest thing on this page: the counts are
 * four short facts, the h1 beside them is one word, and the widest header in the app was still half empty while
 * a run's job graph, the thing this board exists to show, was pushed 40px further down every screen.
 *
 * It only fits there while the pane is wide enough for the title, the counts, the pass rate AND the repository
 * picker on one line: ~7rem + ~21rem + ~13rem, so 44rem, which is the same width <SplitView> folds at and not a
 * coincidence, both numbers are "is there room for two things side by side here". Under it the line goes back
 * above the list, where it costs a row and truncates nothing. Squeezing it into the header instead would take
 * the width out of the h1, which is the mobile complaint this app already has a page of (docs/mobile-ux-audit).
 *
 * Measured off the BODY, not the window: this view renders into the workspace column, which the reader can
 * shrink to half a screen with the chat panel open. The body and the header are the same width (this board has
 * no rail), so the element that can carry the observer answers for the one that cannot. */
const TALLY_AT_REM = 44;
const body = ref<HTMLElement | undefined>(undefined);
const narrowBoard = useNarrow(body, TALLY_AT_REM);
// Nothing to orient by on a board with no runs at all, where the body's own sentence is the whole answer.
const showTally = computed(() => isPending.value || scopedRuns.value.length > 0);

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
        actionError.value = errorMessage(failure);
    } finally {
        busy.value = undefined;
    }
};

// `pick` is set only when the reader used the caret beside this row's button: otherwise the daemon opens the
// session on the sandbox's agent-run list, which is the ordinary path and the one that stays one click long.
const fixRun = async (run: PipelineRun, pick: AgentRunChoice | undefined): Promise<void> => {
    busy.value = actionKey(run);
    actionError.value = undefined;
    try {
        const { conversationId } = await fix.mutateAsync({ run, pick });
        // So the row this reader comes back to says "Agent working" rather than offering to start what it just
        // started. Not awaited: the navigation below is the point, and a roster read is not worth delaying it.
        void refreshFixes();
        // The BOARD with the new card focused, not the agent's diff view: the turn started a second ago and has
        // nothing to review yet, so what the user wants is to watch it work beside their other agents. `?focus`
        // is the fleet's own deep link: it waits for the card to reach the roster, then selects and reveals it.
        api.navigate(`/agents?focus=${encodeURIComponent(conversationId)}`);
    } catch (failure) {
        actionError.value = errorMessage(failure);
    } finally {
        busy.value = undefined;
    }
};
</script>

<template>
    <!-- `scroll="page"`: the body here is a REPORT, not a document. `panes` earns its keep when a long document
         sits beside a long index and losing your place in either costs you something; this index is a handful of
         repositories, and the body is a list of runs that is read top-down once. Clamped, it put a scrollbar
         inside a card inside a page, and the page's own scrollport had nothing to take. -->
    <SplitView title="Pipelines" scroll="page" :scroll-key="scopeRepo">
        <!-- HOW CI IS GOING, ON THE TITLE'S OWN LINE (see TALLY_AT_REM for why it is here and when it is not).
             In the header's #info slot rather than beside the picker in #actions: it is a fact, not a control,
             and the action cluster is `shrink-0`, so a tally in there would push the verbs off the pane instead
             of wrapping. -->
        <template #info>
            <!-- `min-w-0 flex-1`: the tally is the item on this row that can give. Sized from its content it
                 shares the squeeze with the h1 and takes a few characters off "Pipelines" (<PageHeader>'s own
                 note); with a zero basis it takes only what the title, the picker and the repo links leave, and
                 wraps a count onto a second line instead. The same trade <Row> makes for a run's stage graph. -->
            <PipelinesTally v-if="showTally && !narrowBoard" :items="counts" :rate="successRate" :skeleton="isPending" class="ml-1 min-w-0 flex-1" />
        </template>

        <template #actions>
            <!-- Only where there is a choice to make: over one repository this would be a control pointing at the
                 only thing on screen. -->
            <Picker
                v-if="repos.length > 1"
                :model-value="scopeRepo ?? ALL_REPOS"
                :options="repoOptions"
                variant="ghost"
                aria-label="Repository"
                placeholder="Repository"
                @update:model-value="(next) => (scopeRepo = next === ALL_REPOS ? undefined : next)"
            />
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

        <template #detail>
            <!-- No scroller and no `min-h-0 flex-1`: those are what a pane that must shrink inside a clamp asks
                 for, and nothing clamps this now. The column is as tall as the runs in it.
                 THE MEASURED ELEMENT: what this column is wide is what the header above it is wide, and it is
                 the one of the two that a `ref` can reach (see TALLY_AT_REM). -->
            <div ref="body" class="flex flex-col">
                <!-- Too narrow for the header to hold it: the orientation line goes back to being a line, above
                     the list and ahead of the skeleton, so the wait and the board draw the same shape. -->
                <PipelinesTally v-if="showTally && narrowBoard" :items="counts" :rate="successRate" :skeleton="isPending" class="mb-5" />

                <!-- Nothing has come back yet: including the window where the sandbox handshake still gates the
                     fetch. Show the board's shape rather than a bare page that is indistinguishable from "you have
                     no repos connected". -->
                <PipelinesSkeleton v-if="isPending" />

                <template v-else>
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
                                <!-- The REPO itself, not its pipelines: the header action above already owns
                                     that rung, and this line's job is to say which project the group is. Text and
                                     destination agree: the words are the project path, the link is the project. -->
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
