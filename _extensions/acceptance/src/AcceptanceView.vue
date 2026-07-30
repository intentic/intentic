<script setup lang="ts">
import { Button, cmp, Icon, InfoHint, Page, PageHeader, RowGroup, StatusBadge, type StatusVariant, timeAgo } from "@intentic/extension-ui";
import { computed, onMounted, ref } from "vue";
import { markAcceptanceSeen } from "./attention";
import { reposOf, RUNS_DIR } from "./runs";
import RunDialog from "./RunDialog.vue";
import RunReport from "./RunReport.vue";
import type { Story } from "./stories";
import StoryEditor from "./StoryEditor.vue";
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
 * Three surfaces, one per question:
 *  • STORIES — "what have we promised, and what does it take to call it done": every repo's docs/user-stories,
 *    editable here, criteria and all.
 *  • RUNS — "what did the tests say": every run, newest first, each opening into per-story verdicts and reports.
 *  • The agents' own browsers — "what is it doing right now": each live session's Chromium is watchable, and
 *    takeable, in the terminal panel. RunReport owns that button; see useRuns' `browsers`.
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
const { runs, browsers, error: runsError, isLoading: runsLoading, start, useRunOutcomes } = useRuns();
const targets = useTargets();

const runDialogOpen = ref(false);
const editorOpen = ref(false);
// The story being edited; undefined while authoring a new one.
const editing = ref<Story | undefined>(undefined);
// The run whose report is open. Undefined = the lists. Not a route: a report is a disclosure within this view,
// and the view itself is already addressed by /ext/acceptance.
const openRunId = ref<string | undefined>(undefined);
const actionError = ref<string | undefined>(undefined);

const openRun = computed<RunRow | undefined>(() => runs.value.find((run) => run.manifest.runId === openRunId.value));
const outcomes = useRunOutcomes(openRunId);

const topError = computed(() => actionError.value ?? storiesError.value ?? runsError.value);

// Opening the area IS reading it — the rail's badge clears here rather than at the next poll.
onMounted(() => void markAcceptanceSeen());

/* Stories grouped by REPO first, then by their subdirectory within it — the shape the files already have, read
 * outermost-in. A workspace with one repo therefore reads exactly as it did when this was a per-repo panel: one
 * heading, the groups under it. */
const byRepo = computed(() => {
    const groups = new Map<string, Map<string, Story[]>>();
    for (const story of stories.value) {
        const repoGroups = groups.get(story.repo) ?? new Map<string, Story[]>();
        repoGroups.set(story.group, [...(repoGroups.get(story.group) ?? []), story]);
        groups.set(story.repo, repoGroups);
    }
    return [...groups.entries()]
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([repo, repoGroups]) => ({
            repo,
            count: [...repoGroups.values()].reduce((total, entries) => total + entries.length, 0),
            // "" (the top level) first, then named subdirectories alphabetically.
            groups: [...repoGroups.entries()].toSorted(([left], [right]) => (left === `` ? -1 : right === `` ? 1 : left.localeCompare(right))),
        }));
});

/* A run's headline: verdicts once they exist, live status until then. Deliberately NOT a percentage — a run of
 * four stories where one failed is "1 failed", not "75%", and a bar that reads 75% while three tests are still
 * walking a page would be inventing a number nobody can act on. */
const tally = (run: RunRow): { readonly label: string; readonly variant: StatusVariant } => {
    const results = run.manifest.stories.flatMap((story) => {
        const outcome = outcomes.data.value?.[story.slug]?.result;
        return outcome === undefined ? [] : [outcome.verdict];
    });
    if (run.running) {
        // A finished story is one that WROTE something, or whose session has settled — not merely one whose
        // agent is off the roster: archiving a finished agent removes it, and counting roster absence as
        // unfinished would walk the progress backwards while the rest of the run is still going.
        const done = run.manifest.stories.filter((story) => {
            const agent = run.agents.find((entry) => entry.id === story.conversationId);
            return (
                outcomes.data.value?.[story.slug]?.result !== undefined ||
                (agent !== undefined && agent.status !== `running` && agent.status !== `awaiting`)
            );
        }).length;
        return { label: `${done}/${run.manifest.stories.length} done`, variant: `info` };
    }
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

const edit = (story: Story | undefined): void => {
    editing.value = story;
    editorOpen.value = true;
};

// Every mutation reports through the one banner: this view has three write paths (save, delete, start) and a
// failure in any of them is the same kind of news.
const attempt = async (action: () => Promise<void>): Promise<void> => {
    actionError.value = undefined;
    try {
        await action();
    } catch (error) {
        actionError.value = error instanceof Error ? error.message : String(error);
    }
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
                            versioned with the code it describes.
                        </p>
                    </InfoHint>
                </template>
                <template #actions>
                    <Button label="Refresh" size="small" severity="secondary" @click="refreshStories()">
                        <template #icon><Icon name="refresh" /></template>
                    </Button>
                    <Button label="New story" size="small" severity="secondary" :disabled="repos.length === 0" @click="edit(undefined)">
                        <template #icon><Icon name="plus" /></template>
                    </Button>
                    <Button label="Run" size="small" :disabled="stories.length === 0" @click="runDialogOpen = true">
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
                <RunReport :run="openRun" :outcomes="outcomes.data.value ?? {}" :browsers="browsers" :loading="outcomes.isLoading.value" />
            </template>

            <template v-else>
                <section class="mb-8">
                    <div v-if="repos.length === 0 && !storiesLoading" :class="cmp.emptyState()">
                        No repository here runs an app yet. Give one a panel (an <span class="font-mono">operator/</span> directory it can serve) and
                        its stories become testable.
                    </div>
                    <div v-else-if="stories.length === 0 && !storiesLoading" :class="cmp.emptyState()">
                        No stories yet. Write one — a feature from the user's point of view, plus the criteria that decide whether it works — and it
                        becomes one test session per run.
                    </div>
                    <RowGroup v-for="entry in byRepo" :key="entry.repo" :label="entry.repo" :count="entry.count" class="mb-4">
                        <template v-for="[group, entries] in entry.groups" :key="group || 'root'">
                            <div v-if="group !== ``" class="bg-canvas px-4 py-1 font-mono text-2xs text-subtle">{{ group }}/</div>
                            <button
                                v-for="story in entries"
                                :key="story.path"
                                type="button"
                                class="flex w-full cursor-pointer items-center gap-3 px-4 py-2 text-left hover:bg-overlay"
                                @click="edit(story)"
                            >
                                <Icon name="file" class="shrink-0 text-subtle" />
                                <span class="min-w-0 flex-1 truncate text-sm text-content">{{ story.title }}</span>
                                <!-- The criteria count is the story's readiness, at a glance: a story with none
                                     still runs, but nobody has said yet what "done" means for it. -->
                                <span v-if="(criteria[story.path] ?? []).length > 0" class="shrink-0 text-2xs text-subtle">
                                    {{ (criteria[story.path] ?? []).length }} criteria
                                </span>
                                <span v-else class="shrink-0 text-2xs text-warning">no criteria</span>
                                <span class="w-40 shrink-0 truncate text-right font-mono text-2xs text-subtle">{{
                                    story.path.split(`/`).pop()
                                }}</span>
                            </button>
                        </template>
                    </RowGroup>
                    <p v-if="unread > 0" class="mt-2 text-2xs text-subtle">
                        {{ unread }} further story files are listed by filename only — titles, criteria and text are read for the first 200.
                    </p>
                </section>

                <RowGroup label="Runs" :count="runs.length">
                    <div v-if="runs.length === 0 && !runsLoading" :class="cmp.emptyState('m-3')">
                        Nothing has been tested yet. Pick some stories and run them — reports land in
                        <span class="font-mono">{{ RUNS_DIR }}/</span>, outside every repository.
                    </div>
                    <button
                        v-for="row in runs"
                        :key="row.manifest.runId"
                        type="button"
                        class="flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left hover:bg-overlay"
                        @click="openRunId = row.manifest.runId"
                    >
                        <Icon :name="row.running ? `spinner` : `history`" :class="['shrink-0 text-subtle', row.running && `animate-spin`]" />
                        <span class="min-w-0 flex-1">
                            <span class="block truncate text-sm text-content">
                                {{ row.manifest.stories.length }} {{ row.manifest.stories.length === 1 ? `story` : `stories` }}
                            </span>
                            <!-- Which apps this run walked. The repos are the run's subject; the URLs behind them
                                 are in the report, where there is room to say one per repo. -->
                            <span class="block truncate font-mono text-2xs text-subtle">{{ reposOf(row.manifest).join(`, `) }}</span>
                        </span>
                        <StatusBadge :variant="tally(row).variant" :label="tally(row).label" size="xs" />
                        <span class="w-20 shrink-0 text-right text-2xs text-subtle">{{ timeAgo(row.manifest.createdAt) }}</span>
                    </button>
                </RowGroup>
            </template>
        </Page>

        <StoryEditor
            v-model:visible="editorOpen"
            :story="editing"
            :content="editing ? contents[editing.path] : undefined"
            :repos="repos"
            @save="
                (input) =>
                    attempt(async () => {
                        await save(input);
                        editorOpen = false;
                    })
            "
            @remove="
                (path) =>
                    attempt(async () => {
                        await remove(path);
                        editorOpen = false;
                    })
            "
        />
        <RunDialog
            v-model:visible="runDialogOpen"
            :stories="stories"
            :contents="contents"
            :criteria="criteria"
            :notes="notes"
            :targets="targets"
            @submit="run"
        />
    </div>
</template>
