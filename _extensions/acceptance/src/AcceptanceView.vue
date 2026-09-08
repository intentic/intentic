<script setup lang="ts">
import { errorMessage } from "@intentic/base/errors";
import type { PickedModel } from "@intentic/extension-api";
import { runPickOf } from "@intentic/sandbox-contract";
import {
    Checkbox,
    ui,
    Icon,
    Notice,
    noticeOf,
    Page,
    PageAction,
    PageHeader,
    RowGroup,
    StatusBadge,
    timeAgo,
    type StatusVariant,
} from "@intentic/extension-ui";
import { computed, onMounted, ref } from "vue";
import { markAcceptanceSeen } from "./attention";
import DevServerChip from "./DevServerChip.vue";
import { matchesStoryRevision, reposOf, RUNS_DIR, SCAN_RUNS, storyStanding, type Verdict } from "./runs";
import RunControls from "./RunControls.vue";
import RunReport from "./RunReport.vue";
import { newStoryMarkdown, type Story, targetKeyOf } from "./stories";
import StoryComposer from "./StoryComposer.vue";
import StoryRow from "./StoryRow.vue";
import TargetChip from "./TargetChip.vue";
import { launchFailureOf, type RunRow, useRuns } from "./useRuns";
import { useStories } from "./useStories";
import { useTargets } from "./useTargets";

// Workspace-wide list of user stories joined with the newest run's verdict for each; not per-repo, since a promise
// (signing in) can span repos. Authoring and running happen inline in the list (StoryComposer/StoryRow, RunControls),
// never a dialog. A session is an ordinary fleet agent; status, cost and transcript live on the Agents board.

const {
    stories,
    contents,
    notes,
    repos,
    unread,
    error: storiesError,
    isLoading: storiesLoading,
    refresh: refreshStories,
    save,
    remove,
} = useStories();
const { runs, browsers, verdicts, error: runsError, isLoading: runsLoading, start, retry, stop, useRunOutcomes } = useRuns();

// Newest run naming a target wins; a read of what's already on disk (run manifests), not a stored preference, so
// nothing new is written here.
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
const targets = useTargets(remembered);
// Refreshes both stories and targets as one promise, so the button has a single wait to render rather than two
// independent ones.
const refreshEverything = async (): Promise<void> => {
    await Promise.all([refreshStories(), targets.refresh()]);
};

// Ticked for the next run; empty means all, since unpicking is cheaper and a fresh workspace starts unnarrowed.
const selected = ref(new Set<string>());
// The one story open for editing, so there's one draft/autosave and the list doesn't become an accordion form.
const editing = ref<string | undefined>(undefined);
// A just-created story; its row opens focused on the first criterion so the author keeps typing.
const created = ref<string | undefined>(undefined);
// The run whose report is open; undefined means the lists. Not a route: the view is already /ext/acceptance.
const openRunId = ref<string | undefined>(undefined);
const actionError = ref<string | undefined>(undefined);

const openRun = computed<RunRow | undefined>(() => runs.value.find((run) => run.manifest.runId === openRunId.value));
const outcomes = useRunOutcomes(openRunId);

const topError = computed(() => actionError.value ?? storiesError.value ?? targets.error.value ?? runsError.value ?? outcomes.error.value?.message);

// Opening the area clears the rail's unread badge immediately, rather than waiting for the next poll.
onMounted(() => void markAcceptanceSeen());

// Every repo that can hold stories, even empty ones (so its composer is reachable), then its stories by subdirectory in
// the shape the files already have.
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
                // Whether the repo has any ungrouped stories, the ones the heading itself must expose an address for.
                rooted: groups.has(``),
                // Root group ("") first, then named subdirectories alphabetically.
                groups: [...groups.entries()]
                    .toSorted(([left], [right]) => (left === `` ? -1 : right === `` ? 1 : left.localeCompare(right)))
                    .map(([group, entries]) => ({ group, entries, paths: entries.map((story) => story.path) })),
            };
        }),
);

const paths = computed<readonly string[]>(() => stories.value.map((story) => story.path));

// What Run will walk; both the bar and the gate read this rather than recomputing the rule, so scope has one answer.
const chosen = computed<readonly Story[]>(() =>
    selected.value.size === 0 ? stories.value : stories.value.filter((story) => selected.value.has(story.path)),
);

// First-appearance order of the (repo, group) pairs in scope, the keys the run's targets map is built from; one
// representative story per pair.
const groups = computed<readonly Story[]>(() => {
    const seen = new Map<string, Story>();
    for (const story of chosen.value) {
        const key = targetKeyOf(story);
        if (!seen.has(key)) {
            seen.set(key, story);
        }
    }
    return [...seen.values()];
});

// Groups pointed at no address, the only reason a run can be refused (a different `blocked` than a story's verdict; see
// tally).
const blockedGroups = computed<readonly Story[]>(() => groups.value.filter((story) => targets.addressOf(story.repo, story.group) === undefined));
const canRun = computed(() => chosen.value.length > 0 && blockedGroups.value.length === 0);

// Counted in problems, not blocked groups, so one stopped server blocking six groups reads as one remedy. Keyed by repo
// when the server is down/starting, by group when the fix is an address; a repo serving something else is never "not
// running".
const problems = computed<readonly string[]>(() => {
    const found = new Map<string, string>();
    for (const story of blockedGroups.value) {
        const state = targets.stateOf(story.repo);
        if (state === `starting` || state === `stopped`) {
            found.set(story.repo, `${story.repo}'s dev server ${state === `starting` ? `is still starting` : `isn't running`}`);
            continue;
        }
        found.set(targetKeyOf(story), `${targetKeyOf(story)} needs an address`);
    }
    return [...found.values()];
});

const blockedNote = computed<string | undefined>(() => {
    const first = problems.value[0];
    return first === undefined ? undefined : `${first}${problems.value.length > 1 ? ` (+${problems.value.length - 1} more)` : ``}`;
});

// Repos a run is waiting on, projected from the same gate, but only where the server itself is the remedy; a repo with
// no server, or one serving something else, is blocked on an address instead (the group chip's job).
const stalled = computed<ReadonlySet<string>>(
    () => new Set(blockedGroups.value.filter((story) => [`starting`, `stopped`].includes(targets.stateOf(story.repo))).map((story) => story.repo)),
);

const setSelected = (group: readonly string[], on: boolean): void => {
    const next = new Set(selected.value);
    for (const path of group) {
        if (on) {
            next.add(path);
        } else {
            next.delete(path);
        }
    }
    selected.value = next;
};

// Newest run that covered a story wins; an older run still stands if the newest skipped it. Built once per change,
// reading runs newest-first, rather than searched per row.
const statuses = computed<Readonly<Record<string, { readonly label: string; readonly variant: StatusVariant }>>>(() => {
    const found = new Map<string, { readonly label: string; readonly variant: StatusVariant }>();
    for (const run of runs.value) {
        for (const entry of run.manifest.stories) {
            if (found.has(entry.path)) {
                continue;
            }
            // Skipped once the file's revision outruns what a run tested; an unprefetched story's text is unknown here.
            if (!matchesStoryRevision(entry, contents.value[entry.path])) {
                continue;
            }
            const agent = run.agents.find((item) => item.id === entry.conversationId);
            const standing = storyStanding(verdicts.value[run.manifest.runId]?.[entry.slug], agent?.status);
            if (standing !== undefined) {
                found.set(entry.path, standing);
                continue;
            }
            if (launchFailureOf(run, entry.slug) !== undefined) {
                found.set(entry.path, { label: `not started`, variant: `danger` });
            }
        }
    }
    return Object.fromEntries(found);
});

// Placeholder rows only; groups and headings come from workspace facts, not this query, and render at once.
const skeletonBar = `rounded bg-content/10`;
// Varied widths, so the block reads as text rather than a bar chart.
const skeletonTitles = [`w-56`, `w-72`, `w-44`];

// A run's headline: verdicts once known, live progress until then, never a percentage (a run can't turn "1 failed" into
// a rate). Undefined for a run older than the scan, whose results were never read.
const tally = (run: RunRow): { readonly label: string; readonly variant: StatusVariant } | undefined => {
    const known: Readonly<Record<string, Verdict>> | undefined = verdicts.value[run.manifest.runId];
    const notStarted = run.manifest.stories.filter(
        (story) => known?.[story.slug] === undefined && launchFailureOf(run, story.slug) !== undefined,
    ).length;
    if (run.running) {
        // Done means wrote a verdict, hit a launch failure, or settled; roster absence alone doesn't count as finished.
        const done = run.manifest.stories.filter((story) => {
            const agent = run.agents.find((entry) => entry.id === story.conversationId);
            return (
                known?.[story.slug] !== undefined ||
                launchFailureOf(run, story.slug) !== undefined ||
                (agent !== undefined && agent.status !== `running` && agent.status !== `awaiting`)
            );
        }).length;
        return { label: `${done}/${run.manifest.stories.length} done`, variant: `info` };
    }
    if (notStarted > 0 && known === undefined) {
        return { label: `${notStarted} not started`, variant: `danger` };
    }
    if (known === undefined) {
        return undefined;
    }
    const results = run.manifest.stories.flatMap((story) => {
        const verdict = known[story.slug];
        return verdict === undefined ? [] : [verdict];
    });
    if (results.length === 0) {
        // Every session dying is a run failure, not silence, so it gets the danger tone, not a clean "no results".
        if (notStarted > 0) {
            return { label: `${notStarted} not started`, variant: `danger` };
        }
        return run.agents.some((agent) => agent.status === `error`)
            ? { label: `errored`, variant: `danger` }
            : { label: `no results`, variant: `neutral` };
    }
    const failed = results.filter((verdict) => verdict === `fail`).length;
    const blocked = results.filter((verdict) => verdict === `blocked`).length;
    if (failed + notStarted > 0) {
        const parts = [...(failed > 0 ? [`${failed} failed`] : []), ...(notStarted > 0 ? [`${notStarted} not started`] : [])];
        return { label: parts.join(` · `), variant: `danger` };
    }
    if (blocked > 0) {
        return { label: `${blocked} blocked`, variant: `warning` };
    }
    return { label: `${results.length} passed`, variant: `success` };
};

// Tallied once per run, not per binding, since the badge's label, variant and presence are the same read.
const runRows = computed(() => runs.value.map((row) => ({ row, status: tally(row) })));

// Every mutation this view still owns reports through the one banner; the story editor keeps its own save errors in its
// own row instead.
const attempt = async (action: () => Promise<void>): Promise<void> => {
    actionError.value = undefined;
    try {
        await action();
    } catch (error) {
        actionError.value = errorMessage(error);
    }
};

// Creates a story as one file write (a heading); everything else is added in the row that appears. Written immediately,
// not held as a draft, since the file is the story.
const create = (input: { readonly path: string; readonly title: string }): Promise<void> =>
    attempt(async () => {
        await save({ path: input.path, markdown: newStoryMarkdown(input.title) });
        editing.value = input.path;
        created.value = input.path;
    });

const toggle = (path: string): void => {
    editing.value = editing.value === path ? undefined : path;
    created.value = undefined;
};

// The header already decided who, the ticks what; this adds the addresses. Story text is re-read by useRuns at launch,
// so the manifest records the exact revision, including files beyond this list's prefetch.
const run = async (model: PickedModel): Promise<void> =>
    attempt(async () => {
        openRunId.value = await start({
            stories: chosen.value,
            targets: Object.fromEntries(groups.value.map((story) => [targetKeyOf(story), targets.addressOf(story.repo, story.group) ?? ``])),
            // The whole pick, in the wire's own vocabulary: every session in the fan-out opens on it, and Retry
            // reads it back off the manifest months later.
            pick: runPickOf(model),
            notes: notes.value,
        });
    });
</script>

<template>
    <!--
        An ordinary page: the shell's router-view wrapper does the scrolling. RunControls is the last element, a pill sticking to the viewport bottom
        while the list scrolls under it.
    -->
    <Page width="wide">
        <PageHeader title="Acceptance">
            <template #actions>
                <!--
                    One Refresh for the whole page: dev-server states and stories are both re-readable, and a panel started from Preview while this
                    was open is exactly the staleness this clears.
                -->
                <PageAction quiet icon="refresh" label="Refresh" hint="Re-read the stories and the dev-server states" @click="refreshEverything" />
            </template>
        </PageHeader>

        <Notice v-if="topError" :of="noticeOf(topError)" class="mb-4" />

        <!-- One run's report in place of the two lists; a back link, not a tab, since you're viewing a thing, not filtering a list. -->
        <template v-if="openRun">
            <button type="button" :class="ui.textAction(`mb-4`)" @click="openRunId = undefined">
                <Icon name="arrow-left" />
                All runs
            </button>
            <RunReport
                :run="openRun"
                :outcomes="outcomes.data.value ?? {}"
                :browsers="browsers"
                :loading="outcomes.isLoading.value"
                :stop="stop"
                :retry="retry"
            />
        </template>

        <template v-else>
            <section class="mb-8 flex flex-col gap-4">
                <div v-if="repos.length === 0 && !storiesLoading" :class="ui.emptyState()">
                    No repository here runs an app yet. Give one a panel (an <span class="font-mono">operator/</span> directory it can serve) and its
                    stories become testable.
                </div>
                <!-- Count withheld while loading: "0" beside a loading group is a wrong answer, not a pending one. -->
                <RowGroup v-for="entry in byRepo" :key="entry.repo" :label="entry.repo" :count="storiesLoading ? undefined : entry.count">
                    <!--
                        The repo's one dev server (state, address, Start) sits beside its name; an ungrouped story's address rides here too, for want
                        of its own group row. The span is this row's hover scope, so the heading's actions stay reachable.
                    -->
                    <template #actions>
                        <span class="group flex items-center gap-2">
                            <TargetChip v-if="entry.rooted" :repo="entry.repo" group="" :targets="targets" />
                            <DevServerChip :repo="entry.repo" :targets="targets" :blocked="stalled.has(entry.repo)" />
                        </span>
                    </template>

                    <!-- `py-2.5` and `h-5` match StoryRow's own geometry, so real rows land exactly where the placeholders were. -->
                    <template v-if="storiesLoading">
                        <div v-for="row in 3" :key="row" class="flex w-full items-center gap-3 px-4 py-2.5">
                            <span :class="[skeletonBar, `h-4 w-4 shrink-0`]" />
                            <span :class="[skeletonBar, `h-3.5 w-3.5 shrink-0`]" />
                            <span class="flex h-5 min-w-0 flex-1 items-center">
                                <span :class="[skeletonBar, `block h-3`, skeletonTitles[row - 1]]" />
                            </span>
                            <span :class="[skeletonBar, `h-2.5 w-14 shrink-0`]" />
                        </div>
                    </template>
                    <template v-for="section in entry.groups" :key="section.group || 'root'">
                        <!--
                            The group's own row: one tick runs the whole group, and its address shows here only when it isn't simply the repo's dev
                            server above.
                        -->
                        <div v-if="section.group !== ``" class="group flex items-center gap-3 bg-canvas px-4 py-1">
                            <Checkbox
                                :model-value="section.paths.every((path) => selected.has(path))"
                                :indeterminate="
                                    section.paths.some((path) => selected.has(path)) && !section.paths.every((path) => selected.has(path))
                                "
                                binary
                                size="small"
                                class="ui-checkbox-quiet"
                                :aria-label="`Run every story in ${section.group}`"
                                @update:model-value="setSelected(section.paths, $event === true)"
                            />
                            <!-- Quieter than the rows it opens would be a heading nobody finds; this line is the only marker between groups. -->
                            <span class="min-w-0 flex-1 truncate font-mono text-2xs text-muted">{{ section.group }}/</span>
                            <TargetChip :repo="entry.repo" :group="section.group" :targets="targets" />
                        </div>
                        <StoryRow
                            v-for="story in section.entries"
                            :key="story.path"
                            :story="story"
                            :content="contents[story.path]"
                            :expanded="editing === story.path"
                            :status="statuses[story.path]"
                            :autofocus="created === story.path"
                            :selected="selected.has(story.path)"
                            :save="save"
                            :remove="remove"
                            @toggle="toggle(story.path)"
                            @select="setSelected([story.path], $event)"
                            @run="selected = new Set([story.path])"
                        />
                        <!-- One composer per group, so the next story lands beside the ones it belongs with. -->
                        <StoryComposer :repo="entry.repo" :group="section.group" :taken="paths" @create="create" />
                    </template>
                    <!--
                        The top-level composer, rendered here only when the loop above didn't already: a repo with no groups, or none at the top
                        level, still needs a place to start the next story.
                    -->
                    <StoryComposer v-if="!entry.rooted" :repo="entry.repo" group="" :taken="paths" @create="create" />
                </RowGroup>
                <p v-if="unread > 0" class="text-2xs text-subtle">
                    {{ unread }} further story files are listed by filename only: titles, criteria and text are read for the first 200.
                </p>
            </section>

            <!-- Count withheld while the run list is unknown, not shown as a misleading zero. -->
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
                <div v-else-if="runs.length === 0" :class="ui.emptyState('m-3')">
                    Nothing has been tested yet. Press Run below: reports land in
                    <span class="font-mono">{{ RUNS_DIR }}/</span>, outside every repository.
                </div>
                <button
                    v-for="entry in runRows"
                    :key="entry.row.manifest.runId"
                    type="button"
                    class="group flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left hover:bg-overlay"
                    @click="openRunId = entry.row.manifest.runId"
                >
                    <Icon :name="entry.row.running ? `spinner` : `history`" :spin="entry.row.running" class="shrink-0 text-subtle" />
                    <span class="min-w-0 flex-1">
                        <!-- Titles, not a count: "3 stories" makes every run look alike; titles are how you find the one you remember. -->
                        <span class="block truncate text-sm text-content/80 group-hover:text-content">
                            {{ entry.row.manifest.stories.map((story) => story.title).join(` · `) }}
                        </span>
                        <span class="block truncate font-mono text-2xs text-subtle">
                            {{ reposOf(entry.row.manifest).join(`, `) }} · {{ entry.row.manifest.pick.agent }} {{ entry.row.manifest.pick.model }}
                        </span>
                    </span>
                    <StatusBadge v-if="entry.status" :variant="entry.status.variant" :label="entry.status.label" size="xs" />
                    <span class="w-20 shrink-0 text-right text-2xs text-subtle">{{ timeAgo(entry.row.manifest.createdAt) }}</span>
                </button>
            </RowGroup>
            <p v-if="runs.length > SCAN_RUNS" class="mt-2 text-2xs text-subtle">
                Verdicts are read for the newest {{ SCAN_RUNS }} runs. Older ones show theirs when opened.
            </p>

            <!--
                Sticky and last in the page, so it floats over the list while scrolling and settles under it at the end, centred in <Page>. Hidden
                while a report is open, since that's a different question than starting a new run.
            -->
            <RunControls
                v-if="stories.length > 0"
                :chosen="chosen.length"
                :total="stories.length"
                :narrowed="selected.size > 0"
                :blocked="blockedNote"
                :can-run="canRun"
                @clear="selected = new Set()"
                @submit="run"
            />
        </template>
    </Page>
</template>
