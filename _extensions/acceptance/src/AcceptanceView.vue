<script setup lang="ts">
import { Button, cmp, Icon, InfoHint, Page, PageHeader, RowGroup, StatusBadge, type StatusVariant, timeAgo } from "@intentic/extension-ui";
import { computed, onMounted, ref } from "vue";
import { markAcceptanceSeen } from "./attention";
import { reposOf, RUNS_DIR, SCAN_RUNS, type Verdict, verdictTone } from "./runs";
import RunDialog from "./RunDialog.vue";
import RunReport from "./RunReport.vue";
import { type Story, storyMarkdown } from "./stories";
import StoryComposer from "./StoryComposer.vue";
import StoryRow from "./StoryRow.vue";
import type { RunRow } from "./useRuns";
import { useRuns } from "./useRuns";
import { useStories } from "./useStories";
import { useTargets } from "./useTargets";

/* ACCEPTANCE — the workspace's user stories, their acceptance criteria, and what happened when agents walked
 * them through the running app with a real browser.
 *
 * WORKSPACE-WIDE, not per repo, and that is the whole reason this is a rail area rather than a repository panel.
 * A user story is a promise about the product; a product is rarely one repository. Signing in spans the web app
 * and the API, so a run has to be able to carry both and the repo becomes a column in the list rather than the
 * thing that addresses the view. (Contrast git history and codebase health, which are properties OF a repo and
 * belong in its workspace panel.)
 *
 * ONE LIST, TWO QUESTIONS. The stories list is the view: each row is a promise, and each row carries where that
 * promise currently stands — the verdict of the newest run that covered it, or `testing` while a session is still
 * walking the page. That join is the whole point of putting stories and runs on one surface; without it the list
 * is a pile of intentions and the answer to "is anything broken" lives one click deep in a run nobody opened.
 * The runs list below is the history: the same facts addressed by moment rather than by promise.
 *
 * AUTHORING HAPPENS IN THE LIST, not in a dialog. The composer row creates a story from a title alone, and the
 * row expands into its own editor — see StoryComposer and StoryRow for why that shape and not a form.
 *
 * A test session is an ordinary isolated fleet agent, which is why there is no session UI here: the card, the
 * live status, the cost, the transcript and the stop button already exist on the Agents board, and every story
 * row links straight into its own. This view's job is to author the promises, start the runs, and read what came
 * back. */

const {
    stories,
    contents,
    notes,
    criteria,
    repos,
    unread,
    error: storiesError,
    isLoading: storiesLoading,
    refresh: refreshStories,
    save,
    remove,
} = useStories();
const { runs, browsers, verdicts, error: runsError, isLoading: runsLoading, start, stop, useRunOutcomes } = useRuns();
const targets = useTargets();

const runDialogOpen = ref(false);
// Which stories the run dialog opens ticked. Undefined = all of them, the gesture the Run button means; a single
// path is "run this one", the gesture a row means while someone is iterating on it.
const preselect = ref<readonly string[] | undefined>(undefined);
// The one story open for editing. Single, so there is one draft and one autosave in flight, and so the list stays
// a list — an accordion of open editors is a form again by another name.
const editing = ref<string | undefined>(undefined);
// A story created seconds ago: its row opens focused on the first criterion so the author keeps typing.
const created = ref<string | undefined>(undefined);
// The run whose report is open. Undefined = the lists. Not a route: a report is a disclosure within this view,
// and the view itself is already addressed by /ext/acceptance.
const openRunId = ref<string | undefined>(undefined);
const actionError = ref<string | undefined>(undefined);

const openRun = computed<RunRow | undefined>(() => runs.value.find((run) => run.manifest.runId === openRunId.value));
const outcomes = useRunOutcomes(openRunId);

const topError = computed(() => actionError.value ?? storiesError.value ?? runsError.value);

// Opening the area IS reading it — the rail's badge clears here rather than at the next poll.
onMounted(() => void markAcceptanceSeen());

/* Every repo that can hold stories, whether it holds any yet or not, then its stories by subdirectory — the shape
 * the files already have, read outermost-in. Listing the EMPTY repos matters: the composer lives in the group, so
 * a repo missing from this list is a repo nobody can write the first story for. A workspace with one repo reads
 * exactly as it did when this was a per-repo panel: one heading, the groups under it. */
const byRepo = computed(() =>
    [...repos.value]
        .toSorted((left, right) => left.localeCompare(right))
        .map((repo) => {
            const own = stories.value.filter((story) => story.repo === repo);
            const groups = new Map<string, Story[]>();
            for (const story of own) {
                groups.set(story.group, [...(groups.get(story.group) ?? []), story]);
            }
            return {
                repo,
                count: own.length,
                // "" (the top level) first, then named subdirectories alphabetically.
                groups: [...groups.entries()].toSorted(([left], [right]) => (left === `` ? -1 : right === `` ? 1 : left.localeCompare(right))),
            };
        }),
);

const paths = computed<readonly string[]>(() => stories.value.map((story) => story.path));

/* THE ADDRESS EACH GROUP WAS LAST RUN AGAINST — the newest run that named it wins. A group that points somewhere
 * other than its repo's dev server (a marketing site on its own port) should be typed once, not once per run, and
 * the manifests already on disk are the record of what was chosen. So this is a read of what is already in hand
 * rather than a preference to store: nothing new is written, and a run's own history is what remembers. */
const remembered = computed<Readonly<Record<string, string>>>(() => {
    const found = new Map<string, string>();
    for (const run of runs.value) {
        for (const [key, url] of Object.entries(run.manifest.targets)) {
            if (url !== `` && !found.has(key)) {
                found.set(key, url);
            }
        }
    }
    return Object.fromEntries(found);
});

/* WHERE EVERY PROMISE STANDS, by story path: the newest run that covered it and had something to say. Older runs
 * are consulted when the newest never included the story — a story tested last week and untouched since is still
 * telling you something, and blanking it because today's run skipped it would lose the only verdict there is.
 * Bounded by useRuns' scan: a story whose last run has aged out of it simply shows nothing rather than a guess.
 *
 * Built once per change rather than asked per row: runs are newest-first, so the first run with an answer for a
 * path wins and everything behind it is skipped. */
const statuses = computed<Readonly<Record<string, { readonly label: string; readonly variant: StatusVariant }>>>(() => {
    const found = new Map<string, { readonly label: string; readonly variant: StatusVariant }>();
    for (const run of runs.value) {
        for (const entry of run.manifest.stories) {
            if (found.has(entry.path)) {
                continue;
            }
            const verdict = verdicts.value[run.manifest.runId]?.[entry.slug];
            if (verdict !== undefined) {
                found.set(entry.path, { label: verdict, variant: verdictTone(verdict) });
                continue;
            }
            const agent = run.agents.find((item) => item.id === entry.conversationId);
            if (agent?.status === `running` || agent?.status === `awaiting`) {
                found.set(entry.path, { label: `testing`, variant: `info` });
            }
        }
    }
    return Object.fromEntries(found);
});

/* LOADING KEEPS THE SHAPE. Both lists here are a request away, and an area that paints blank and then pops a
 * list in reads as broken on a slow sandbox. So the rows that are coming stand in for themselves — the app's
 * skeleton idiom (see the Sandbox hub's connections list): a pulsing bar wherever text will land, in the row's
 * own geometry, inside the real surface.
 *
 * Only the ROWS are placeholders. The repo groups around them are already known — `byRepo` is built from
 * workspace facts, not from this query — so the headings, and the composer that ends each group, are the real
 * ones from the first paint. */
const skeletonBar = `animate-pulse rounded bg-content/10`;
// Varied so the block reads as text rather than as a bar chart.
const skeletonTitles = [`w-56`, `w-72`, `w-44`];

/* A run's headline: verdicts once they exist, live progress until then. Deliberately NOT a percentage — a run of
 * four stories where one failed is "1 failed", not "75%", and a bar that reads 75% while three tests are still
 * walking a page would be inventing a number nobody can act on.
 *
 * Undefined for a run older than the scan: its results were never read, and "no results" would be a claim about a
 * run this view knows nothing about. Opening it reads them. */
const tally = (run: RunRow): { readonly label: string; readonly variant: StatusVariant } | undefined => {
    const known: Readonly<Record<string, Verdict>> | undefined = verdicts.value[run.manifest.runId];
    if (run.running) {
        // A finished story is one that WROTE something, or whose session has settled — not merely one whose
        // agent is off the roster: archiving a finished agent removes it, and counting roster absence as
        // unfinished would walk the progress backwards while the rest of the run is still going.
        const done = run.manifest.stories.filter((story) => {
            const agent = run.agents.find((entry) => entry.id === story.conversationId);
            return known?.[story.slug] !== undefined || (agent !== undefined && agent.status !== `running` && agent.status !== `awaiting`);
        }).length;
        return { label: `${done}/${run.manifest.stories.length} done`, variant: `info` };
    }
    if (known === undefined) {
        return undefined;
    }
    const results = run.manifest.stories.flatMap((story) => {
        const verdict = known[story.slug];
        return verdict === undefined ? [] : [verdict];
    });
    if (results.length === 0) {
        return { label: run.agents.some((agent) => agent.status === `error`) ? `errored` : `no results`, variant: `neutral` };
    }
    const failed = results.filter((verdict) => verdict === `fail`).length;
    const blocked = results.filter((verdict) => verdict === `blocked`).length;
    if (failed > 0) {
        return { label: `${failed} failed`, variant: `danger` };
    }
    if (blocked > 0) {
        return { label: `${blocked} blocked`, variant: `warning` };
    }
    return { label: `${results.length} passed`, variant: `success` };
};

// Tallied once per run rather than per binding: the badge, its variant and its presence are three reads of the
// same answer.
const runRows = computed(() => runs.value.map((row) => ({ row, status: tally(row) })));

// Every mutation this view still owns reports through the one banner. The story editor keeps its own failures in
// the row that caused them — a save error belongs where the text you typed is, not at the top of a scrolled page.
const attempt = async (action: () => Promise<void>): Promise<void> => {
    actionError.value = undefined;
    try {
        await action();
    } catch (error) {
        actionError.value = error instanceof Error ? error.message : String(error);
    }
};

/* Creating a story is one write of the plainest possible file: a heading. Everything else is added in the row
 * that appears, which is why this can be a keystroke rather than a form — and why the empty story is written to
 * disk immediately instead of being held as a draft. The file IS the story; a draft that only exists in a browser
 * tab is a story that can be lost by closing it. */
const create = (input: { readonly path: string; readonly title: string }): Promise<void> =>
    attempt(async () => {
        await save({ path: input.path, markdown: storyMarkdown({ title: input.title, narrative: ``, criteria: [] }) });
        editing.value = input.path;
        created.value = input.path;
    });

const toggle = (path: string): void => {
    editing.value = editing.value === path ? undefined : path;
    created.value = undefined;
};

const openRunDialog = (only?: readonly string[]): void => {
    preselect.value = only;
    runDialogOpen.value = true;
};

const run = async (input: Parameters<typeof start>[0]): Promise<void> =>
    attempt(async () => {
        openRunId.value = await start(input);
        runDialogOpen.value = false;
    });
</script>

<template>
    <div class="h-full min-h-0 overflow-auto scrollbar-thin">
        <Page width="wide">
            <PageHeader
                title="Acceptance"
                description="User stories and their acceptance criteria, walked through the running app by agents driving browsers."
            >
                <template #info>
                    <InfoHint label="How a run works">
                        <p class="text-xs text-muted">
                            Each selected story starts its own isolated agent session. It opens the app in a real Chromium, walks every acceptance
                            criterion, screenshots each step, then writes a verdict and a report.
                        </p>
                        <p class="mt-2 text-xs text-muted">
                            You can watch any session's browser live — and take control of it — from the report. Sessions also appear on the Agents
                            board like any other. Reports and screenshots land in <span class="font-mono">{{ RUNS_DIR }}/</span>, outside every
                            repository, so a run never shows up in your changes.
                        </p>
                        <p class="mt-2 text-xs text-muted">
                            Stories themselves are markdown in each repo's <span class="font-mono">docs/user-stories/</span> — product documentation,
                            versioned with the code it describes. Editing one here writes that file; there is no separate copy.
                        </p>
                        <p class="mt-2 text-xs text-muted">
                            A subdirectory of that is a group, and a run picks one address per group — so a repository serving both a marketing site
                            and an app can walk each of them, against its own server, in the same run.
                        </p>
                    </InfoHint>
                </template>
                <template #actions>
                    <Button label="Refresh" size="small" severity="secondary" @click="refreshStories()">
                        <template #icon><Icon name="refresh" /></template>
                    </Button>
                    <Button label="Run" size="small" :disabled="stories.length === 0" @click="openRunDialog()">
                        <template #icon><Icon name="play" /></template>
                    </Button>
                </template>
            </PageHeader>

            <div v-if="topError" :class="cmp.alertDanger('mb-4')">{{ topError }}</div>

            <!-- ONE run's report, in place of the two lists. A back link rather than a tab: you are looking at a
                 thing, not filtering a list. -->
            <template v-if="openRun">
                <button
                    type="button"
                    class="mb-4 flex cursor-pointer items-center gap-1.5 text-xs text-muted hover:text-content"
                    @click="openRunId = undefined"
                >
                    <Icon name="arrow-left" />
                    All runs
                </button>
                <RunReport
                    :run="openRun"
                    :outcomes="outcomes.data.value ?? {}"
                    :browsers="browsers"
                    :loading="outcomes.isLoading.value"
                    :stop="stop"
                />
            </template>

            <template v-else>
                <section class="mb-8 flex flex-col gap-4">
                    <div v-if="repos.length === 0 && !storiesLoading" :class="cmp.emptyState()">
                        No repository here runs an app yet. Give one a panel (an <span class="font-mono">operator/</span> directory it can serve) and
                        its stories become testable.
                    </div>
                    <!-- The count is withheld while the stories are still being read: "0" beside a loading group
                         is a wrong answer, not a pending one. -->
                    <RowGroup v-for="entry in byRepo" :key="entry.repo" :label="entry.repo" :count="storiesLoading ? undefined : entry.count">
                        <!-- `py-2.5` and the `h-5` line box are StoryRow's own geometry, so the rows that arrive
                             land exactly where their placeholders were. -->
                        <template v-if="storiesLoading">
                            <div v-for="row in 3" :key="row" class="flex w-full items-center gap-3 px-4 py-2.5">
                                <span :class="[skeletonBar, `h-3.5 w-3.5 shrink-0`]" />
                                <span class="flex h-5 min-w-0 flex-1 items-center">
                                    <span :class="[skeletonBar, `block h-3`, skeletonTitles[row - 1]]" />
                                </span>
                                <span :class="[skeletonBar, `h-2.5 w-14 shrink-0`]" />
                            </div>
                        </template>
                        <template v-for="[group, entries] in entry.groups" :key="group || 'root'">
                            <div v-if="group !== ``" class="bg-canvas px-4 py-1 font-mono text-2xs text-subtle">{{ group }}/</div>
                            <StoryRow
                                v-for="story in entries"
                                :key="story.path"
                                :story="story"
                                :content="contents[story.path]"
                                :expanded="editing === story.path"
                                :status="statuses[story.path]"
                                :autofocus="created === story.path"
                                :save="save"
                                :remove="remove"
                                @toggle="toggle(story.path)"
                                @run="openRunDialog([story.path])"
                            />
                            <!-- One composer per group, so the next story lands beside the ones it belongs with. -->
                            <StoryComposer :repo="entry.repo" :group="group" :taken="paths" @create="create" />
                        </template>
                        <!-- The top level's own composer, when the loop above did not already render it: a repo
                             with no stories yet has no groups at all, and one whose stories all sit in
                             subdirectories has no top-level row to type in. Writing the next story is the thing
                             this list is for, so the last row is always a place to start one. -->
                        <StoryComposer
                            v-if="!entry.groups.some(([group]) => group === ``)"
                            :repo="entry.repo"
                            group=""
                            :taken="paths"
                            @create="create"
                        />
                    </RowGroup>
                    <p v-if="unread > 0" class="text-2xs text-subtle">
                        {{ unread }} further story files are listed by filename only — titles, criteria and text are read for the first 200.
                    </p>
                </section>

                <!-- The count is withheld while the list is unknown: "0" next to a loading list is a wrong
                     answer, not a pending one. -->
                <RowGroup label="Runs" :count="runsLoading ? undefined : runs.length">
                    <template v-if="runsLoading">
                        <div v-for="row in 2" :key="row" class="flex w-full items-center gap-3 px-4 py-2.5">
                            <span :class="[skeletonBar, `h-3.5 w-3.5 shrink-0`]" />
                            <!-- The two line boxes a run row stacks: text-sm over text-2xs. -->
                            <span class="min-w-0 flex-1">
                                <span class="flex h-5 items-center"><span :class="[skeletonBar, `block h-3 w-24`]" /></span>
                                <span class="flex h-4 items-center"><span :class="[skeletonBar, `block h-2.5 w-40`]" /></span>
                            </span>
                            <span :class="[skeletonBar, `h-4 w-16 shrink-0 rounded-full`]" />
                            <span :class="[skeletonBar, `h-2.5 w-20 shrink-0`]" />
                        </div>
                    </template>
                    <div v-else-if="runs.length === 0" :class="cmp.emptyState('m-3')">
                        Nothing has been tested yet. Pick some stories and run them — reports land in
                        <span class="font-mono">{{ RUNS_DIR }}/</span>, outside every repository.
                    </div>
                    <button
                        v-for="entry in runRows"
                        :key="entry.row.manifest.runId"
                        type="button"
                        class="flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left hover:bg-overlay"
                        @click="openRunId = entry.row.manifest.runId"
                    >
                        <Icon
                            :name="entry.row.running ? `spinner` : `history`"
                            :class="['shrink-0 text-subtle', entry.row.running && `animate-spin`]"
                        />
                        <span class="min-w-0 flex-1">
                            <!-- What it TESTED, not how many. "3 stories" makes every run in the list look like
                                 every other one; the titles are how someone finds the run they remember. -->
                            <span class="block truncate text-sm text-content">
                                {{ entry.row.manifest.stories.map((story) => story.title).join(` · `) }}
                            </span>
                            <span class="block truncate font-mono text-2xs text-subtle">
                                {{ reposOf(entry.row.manifest).join(`, `) }} · {{ entry.row.manifest.provider
                                }}{{ entry.row.manifest.model ? ` ${entry.row.manifest.model}` : `` }}
                            </span>
                        </span>
                        <StatusBadge v-if="entry.status" :variant="entry.status.variant" :label="entry.status.label" size="xs" />
                        <span class="w-20 shrink-0 text-right text-2xs text-subtle">{{ timeAgo(entry.row.manifest.createdAt) }}</span>
                    </button>
                </RowGroup>
                <p v-if="runs.length > SCAN_RUNS" class="mt-2 text-2xs text-subtle">
                    Verdicts are read for the newest {{ SCAN_RUNS }} runs. Older ones show theirs when opened.
                </p>
            </template>
        </Page>

        <RunDialog
            v-model:visible="runDialogOpen"
            :stories="stories"
            :contents="contents"
            :criteria="criteria"
            :notes="notes"
            :targets="targets"
            :remembered="remembered"
            :preselect="preselect"
            @submit="run"
        />
    </div>
</template>
