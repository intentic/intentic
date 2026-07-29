<script setup lang="ts">
import { Button, Card, cmp, Icon, InfoHint, Page, PageHeader, RowGroup, StatusBadge, type StatusVariant, timeAgo } from "@intentic/extension-ui";
import { computed, ref, toRef } from "vue";
import RunDialog from "./RunDialog.vue";
import RunReport from "./RunReport.vue";
import type { RunRow } from "./useRuns";
import { useRuns } from "./useRuns";
import { useStories } from "./useStories";
import { useTarget } from "./useTarget";

/* Exploratory tests: a repo's user stories, walked through the running app by an LLM with a real browser.
 *
 * The page is two halves and they answer different questions. STORIES is "what could I test" — the repo's
 * docs/user-stories, selectable, with one Run button. RUNS is "what did the tests say" — every run this repo has
 * ever had, newest first, each expandable into per-story verdicts, reports and screenshots.
 *
 * A test session is an ordinary isolated fleet agent, which is why there is no session UI here at all: the card,
 * the live status, the cost, the transcript and the stop button already exist on the Agents board, and every
 * story row links straight into its own. This view's job is to start them and to read what they wrote. */

const { repo } = defineProps<{ repo: string }>();
const repoRef = toRef(() => repo);

const { stories, contents, projectNotes, unread, error: storiesError, isLoading: storiesLoading, refresh: refreshStories } = useStories(repoRef);
const { runs, error: runsError, isLoading: runsLoading, start, useRunOutcomes } = useRuns(repoRef);
const target = useTarget(repoRef);

const dialogOpen = ref(false);
// The run whose report is open. Undefined = the list. Not a route: a report is a disclosure within this view,
// and the view itself is already addressed by /ext/exploratory-tests/<repo>.
const openRunId = ref<string | undefined>(undefined);
const startError = ref<string | undefined>(undefined);

const openRun = computed<RunRow | undefined>(() => runs.value.find((run) => run.manifest.runId === openRunId.value));
const outcomes = useRunOutcomes(openRunId);

const topError = computed(() => startError.value ?? storiesError.value ?? runsError.value);

// Stories grouped by their subdirectory, top-level first — the shape the directory already has, so the list
// reads like the tree the author wrote.
const groups = computed(() => {
    const byGroup = new Map<string, typeof stories.value>();
    for (const story of stories.value) {
        byGroup.set(story.group, [...(byGroup.get(story.group) ?? []), story]);
    }
    return [...byGroup.entries()].toSorted(([left], [right]) => (left === `` ? -1 : right === `` ? 1 : left.localeCompare(right)));
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
            return outcomes.data.value?.[story.slug]?.result !== undefined || (agent !== undefined && agent.status !== `running` && agent.status !== `awaiting`);
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

const run = async (input: Parameters<typeof start>[0]): Promise<void> => {
    startError.value = undefined;
    try {
        openRunId.value = await start(input);
        dialogOpen.value = false;
    } catch (error) {
        startError.value = error instanceof Error ? error.message : String(error);
    }
};
</script>

<template>
    <div class="h-full min-h-0 overflow-auto scrollbar-thin">
        <Page width="wide">
            <PageHeader title="Exploratory tests" :description="`User stories in ${repo}, walked through the running app by an agent.`">
                <template #info>
                    <InfoHint label="How a run works">
                        <p class="text-xs text-muted">
                            Each selected story starts its own isolated agent session: it drives a real browser through the story, screenshots every step, and
                            writes a report.
                        </p>
                        <p class="mt-2 text-xs text-muted">
                            Sessions appear on the Agents board like any other — open one to watch it work, or stop it. Reports and screenshots are written to
                            <span class="font-mono">.intentic/exploratory/</span>, outside every repository, so a run never shows up in your changes.
                        </p>
                    </InfoHint>
                </template>
                <template #actions>
                    <Button label="Refresh" size="small" severity="secondary" @click="refreshStories()">
                        <template #icon><Icon name="refresh" /></template>
                    </Button>
                    <Button label="Run tests" size="small" :disabled="stories.length === 0" @click="dialogOpen = true">
                        <template #icon><Icon name="play" /></template>
                    </Button>
                </template>
            </PageHeader>

            <div v-if="topError" :class="cmp.alertDanger('mb-4')">{{ topError }}</div>

            <!-- ONE run's report, in place of the two lists. A back link rather than a tab: you are looking at a
                 thing, not filtering a list. -->
            <template v-if="openRun">
                <button type="button" class="mb-4 flex cursor-pointer items-center gap-1.5 text-xs text-muted hover:text-content" @click="openRunId = undefined">
                    <Icon name="arrow-left" />
                    All runs
                </button>
                <RunReport :run="openRun" :outcomes="outcomes.data.value ?? {}" :loading="outcomes.isLoading.value" />
            </template>

            <template v-else>
                <section class="mb-8">
                    <div v-if="stories.length === 0 && !storiesLoading" :class="cmp.emptyState()">
                        No stories yet — add a markdown file under <span class="font-mono">docs/user-stories/</span> describing one feature from the user's
                        point of view, and it becomes one test session.
                    </div>
                    <RowGroup
                        v-for="[group, entries] in groups"
                        :key="group || 'root'"
                        :label="group === `` ? `Stories` : group"
                        :count="entries.length"
                        class="mb-4"
                    >
                        <div v-for="story in entries" :key="story.path" class="flex items-center gap-3 px-4 py-2">
                            <Icon name="file" class="shrink-0 text-subtle" />
                            <span class="min-w-0 flex-1 truncate text-sm text-content">{{ story.title }}</span>
                            <span class="shrink-0 truncate font-mono text-2xs text-subtle">{{ story.path.split(`/`).pop() }}</span>
                        </div>
                    </RowGroup>
                    <p v-if="unread > 0" class="mt-2 text-2xs text-subtle">
                        {{ unread }} further story files are listed by filename only — titles and text are read for the first 200.
                    </p>
                </section>

                <RowGroup label="Runs" :count="runs.length">
                    <div v-if="runs.length === 0 && !runsLoading" :class="cmp.emptyState('m-3')">
                        Nothing has been tested yet. Pick some stories and run them — reports land in
                        <span class="font-mono">.intentic/exploratory/</span>, outside the repository.
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
                            <span class="block truncate font-mono text-2xs text-subtle">{{ row.manifest.baseUrl }}</span>
                        </span>
                        <StatusBadge :variant="tally(row).variant" :label="tally(row).label" size="xs" />
                        <span class="w-20 shrink-0 text-right text-2xs text-subtle">{{ timeAgo(row.manifest.createdAt) }}</span>
                    </button>
                </RowGroup>

                <Card v-if="!target.hasPanel.value && stories.length > 0" class="mt-6 p-4">
                    <p class="text-xs text-muted">
                        <span class="font-mono">{{ repo }}</span> has no dev server the daemon can start, so a run needs a URL you supply — a staging
                        deployment, or an app you started yourself in a terminal.
                    </p>
                </Card>
            </template>
        </Page>

        <RunDialog
            v-model:visible="dialogOpen"
            :repo="repo"
            :stories="stories"
            :contents="contents"
            :project-notes="projectNotes"
            :target="target"
            @submit="run"
        />
    </div>
</template>
