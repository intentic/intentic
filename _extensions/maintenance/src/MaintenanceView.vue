<script setup lang="ts">
import { errorMessage } from "@intentic/base/errors";
import { CHORE_KINDS, CHORES, choreAnswered, type ChoreVerdict, repoName } from "@intentic/sandbox-contract/chores";
import {
    Button,
    Notice,
    noticeOf,
    PageAction,
    RepoRail,
    type RepoRailAll,
    type RepoRailGroup,
    RowGroup,
    SegmentedControl,
    SplitView,
    type AgentRunChoice,
} from "@intentic/extension-ui";
import { computed, ref, watch } from "vue";
import { acknowledge } from "./attention";
import ChoreRow from "./ChoreRow.vue";
import { host } from "./host";
import MaintenanceSkeleton from "./MaintenanceSkeleton.vue";
import { conversationIdOf } from "./runs";
import ScopeNote from "./ScopeNote.vue";
import { useChores } from "./useChores";
import { useRuns } from "./useRuns";

// The chore book for this workspace: rows are decided and acted on per repository, then grouped by kind so one urgent
// risk doesn't hide among several that can wait. Every count on the page reflects only outstanding, unanswered chores.

// Bound by the host for a `directory` activation; absent for the rail's own workspace-wide tile.
const { repo: pinned } = defineProps<{ repo?: string }>();

const api = host();
const { byRepo, error, isPending, measuring, refresh, refreshProbe, snooze } = useChores();
const { latestByChore, start, promote } = useRuns();

type Filter = "attention" | "all";
const filter = ref<Filter>(`attention`);
const expanded = ref<string>();
const busy = ref(false);
const notice = ref<string>();

// Repository lives in the URL query, not a mirrored ref, so Back/Forward work and the view is linkable. Absent means
// every repository; the filter stays out of the URL.
const query = computed(() => api.route.query());
const repo = computed<string | undefined>({
    get: () => pinned ?? query.value[`repo`],
    set: (value) => api.route.setQuery({ repo: value }),
});

const rowKey = (verdict: ChoreVerdict): string => `${verdict.repo}|${verdict.chore.id}`;

// A month: long enough to skip a cycle, short enough not to outlive its own reason.
const SNOOZE_MS = 30 * 86_400_000;

// Rail shows the due count; whether any is being carried is the row's colour, not a second number illegible at this
// width. The split is spelled out in the tooltip.
const railTone = (carrying: number): string => (carrying > 0 ? `text-warning` : ``);
const railNote = (due: number, carrying: number): string =>
    carrying === 0 ? `${due} due` : `${due} due · ${carrying} a risk being carried right now`;

// Single source every count on this page derives from: a due chore whose answer still stands (`choreAnswered`) is not
// outstanding, matching `unseenVerdicts`.
const outstanding = (verdict: ChoreVerdict): boolean => verdict.state === `due` && !choreAnswered(verdict);

const counts = computed(() =>
    byRepo.value.map(({ repo: at, verdicts }) => ({
        repo: at,
        due: verdicts.filter((verdict) => outstanding(verdict)).length,
        carrying: verdicts.filter((verdict) => outstanding(verdict) && verdict.severity === `warning`).length,
    })),
);

// One unlabelled group: a heading over the rail's only group would name a distinction that isn't made.
const railGroups = computed<RepoRailGroup[]>(() => [
    {
        key: `repos`,
        rows: counts.value.map((entry) => ({
            value: entry.repo,
            label: repoName(entry.repo),
            icon: `folder`,
            meta: String(entry.due),
            tone: railTone(entry.carrying),
            tooltip: railNote(entry.due, entry.carrying),
        })),
    },
]);

const railAll = computed<RepoRailAll>(() => {
    const due = counts.value.reduce((sum, entry) => sum + entry.due, 0);
    const carrying = counts.value.reduce((sum, entry) => sum + entry.carrying, 0);
    return { icon: `wrench`, meta: String(due), tone: railTone(carrying), tooltip: railNote(due, carrying) };
});

// True when the view chooses scope, not the host. Not 'more than one repo': that's unknown until the report lands, and
// would shift the layout after render.
const railed = computed(() => pinned === undefined);

const scoped = computed(() => (repo.value === undefined ? byRepo.value : byRepo.value.filter((group) => group.repo === repo.value)));

// Not-applicable chores are never rows; <ScopeNote> counts and explains them under the list instead.
// `stale` counts as needing attention: it is the state a chore lands in right after a turn finishes it.
const shown = (verdict: ChoreVerdict): boolean =>
    verdict.state !== `not-applicable` &&
    (filter.value === `all` || verdict.state === `due` || verdict.state === `snoozed` || verdict.state === `stale`);

// Chore-major, not repo-major: under 'All repositories' the same chore's rows sit together. CHORES is already in kind
// order, so groups come out ordered for free.
const rows = computed(() =>
    CHORES.flatMap((chore) => scoped.value.flatMap((group) => group.verdicts.filter((verdict) => verdict.chore.id === chore.id && shown(verdict)))),
);

const groups = computed(() =>
    CHORE_KINDS.flatMap((spec) => {
        const kindRows = rows.value.filter((verdict) => verdict.chore.kind === spec.kind);
        // Drops the kind entirely rather than rendering an empty heading.
        if (kindRows.length === 0) {
            return [];
        }
        return [
            {
                kind: spec.kind,
                label: spec.label,
                caption: spec.caption,
                // Answered rows sink via a stable sort, not a filter; the book's order survives within each half.
                rows: [...kindRows].sort((a, b) => Number(choreAnswered(a)) - Number(choreAnswered(b))),
                // Counts what is outstanding, not the row count: matters once 'Everything' shows the whole group.
                due: kindRows.filter((verdict) => outstanding(verdict)).length,
            },
        ];
    }),
);

// Set when exactly one repository is in scope, including 'All repositories' in a single-repo workspace.
const only = computed(() => (scoped.value.length === 1 ? scoped.value[0] : undefined));
// True once more than one repository is in scope, where the repo name is what tells rows apart.
const showRepo = computed(() => scoped.value.length > 1);

// Same definition as every other count here; snoozed and stale rows are listed but not counted.
const scopeDue = computed(() => scoped.value.flatMap((group) => group.verdicts).filter((verdict) => outstanding(verdict)).length);

// Acknowledges only the rendered rows, immediately on mount; idempotent by digest so repeats are cheap.
watch(
    rows,
    (verdicts) => {
        void acknowledge(verdicts);
    },
    { immediate: true },
);

// Workspace-wide on purpose: a finished run is a ledger fact regardless of what's currently in view.
const ledgerRunIds = computed(
    () =>
        new Set(byRepo.value.flatMap((group) => group.verdicts).flatMap((verdict) => (verdict.lastRun === undefined ? [] : [verdict.lastRun.runId]))),
);
watch(
    [latestByChore, ledgerRunIds],
    () => {
        void promote(ledgerRunIds.value);
    },
    { immediate: true },
);

// Single failure path for every action; each is a one-click request whose only feedback is that something happened.
const attempt = async (what: string, action: () => Promise<unknown>): Promise<void> => {
    busy.value = true;
    notice.value = undefined;
    try {
        await action();
    } catch (failure) {
        notice.value = `Could not ${what}: ${errorMessage(failure)}`;
    } finally {
        busy.value = false;
    }
};

// Re-measures everything the chore needs, from its own row; works under 'All repositories' since the row carries its
// repo. `attempt` only covers the request; `measuring` tracks the actual sweep.
const onRemeasure = (verdict: ChoreVerdict): void => {
    void attempt(`ask for that measurement`, async () => {
        await Promise.all(verdict.chore.needs.map((id) => refreshProbe(verdict.repo, id)));
    });
};

// `pick` is set only via the caret beside the button; otherwise the daemon opens on the sandbox's agent-run list.
const onStart = (verdict: ChoreVerdict, pick: AgentRunChoice | undefined): void => {
    void attempt(`start that turn`, async () => {
        // Opens the new conversation immediately; the row stays behind and will show the run on return.
        api.chat.openSession(conversationIdOf(await start(verdict, pick)));
    });
};
</script>

<template>
    <!-- `scroll="page"`: this body is a report read top-down, not a clamped panel with its own scroller. -->
    <SplitView title="Maintenance" scroll="page" :scroll-key="`${repo ?? ``}/${filter}`">
        <template #actions>
            <SegmentedControl
                v-model="filter"
                size="xs"
                :options="[
                    { label: `Needs attention`, value: `attention`, badge: scopeDue, title: `Chores that are due or snoozed` },
                    { label: `Everything`, value: `all`, title: `Every chore in the book, including the clear and the unmeasured` },
                ]"
            />
            <!-- Re-reads the latest results; it does not re-measure. Measuring again is a per-chore decision made on the row. -->
            <PageAction
                quiet
                icon="refresh"
                label="Reload"
                hint="Re-read the latest results: to measure again, open a chore"
                :disabled="busy"
                @click="refresh"
            />
        </template>

        <!--
            Slot only passed when there is a notice, so the strip reserves no margin when empty. Inapplicable chores get a footnote under the list
            instead (<ScopeNote>).
        -->
        <template v-if="notice || error" #strips>
            <Notice v-if="notice" tone="warning">{{ notice }}</Notice>
            <Notice v-if="error" :of="noticeOf(error)" />
        </template>

        <template v-if="railed" #rail>
            <RepoRail v-model="repo" :groups="railGroups" :all="railAll" memory="maintenance.repo" />
        </template>

        <template #detail>
            <!-- Gap stays; the scroller and shrink-to-fit belong to SplitView, not this wrapper. -->
            <div class="flex flex-col gap-6">
                <!-- Also covers the window before the sandbox handshake unblocks the fetch. Shows the book's shape, not a loading sentence. -->
                <MaintenanceSkeleton v-if="isPending" />

                <!-- The empty state this design most wants reachable; states what was checked rather than congratulating. -->
                <div v-else-if="groups.length === 0" class="flex flex-col items-start gap-2 py-10">
                    <p class="text-sm text-content">Nothing needs attention.</p>
                    <p class="max-w-read-sm text-xs text-subtle">
                        Every chore in the book is either clear or waiting on a measurement. Switch to Everything to see what was checked, when, and
                        what could not be measured at all.
                    </p>
                    <Button size="small" severity="secondary" text label="Show everything" @click="filter = `all`" />
                </div>

                <!-- One group per kind, in the book's own order; each heading carries its own argument from CHORE_KINDS. -->
                <template v-else>
                    <RowGroup
                        v-for="group in groups"
                        :key="group.kind"
                        :label="group.label"
                        :count="group.due === 0 ? undefined : group.due"
                        :caption="group.caption"
                    >
                        <ChoreRow
                            v-for="verdict in group.rows"
                            :key="rowKey(verdict)"
                            :verdict="verdict"
                            :run="latestByChore.get(rowKey(verdict))"
                            :measuring="measuring"
                            :expanded="expanded === rowKey(verdict)"
                            :show-repo="showRepo"
                            :busy="busy"
                            @toggle="expanded = expanded === rowKey(verdict) ? undefined : rowKey(verdict)"
                            @start="(pick) => onStart(verdict, pick)"
                            @remeasure="onRemeasure(verdict)"
                            @snooze="void attempt(`snooze that chore`, () => snooze(verdict, Date.now() + SNOOZE_MS))"
                            @unsnooze="void attempt(`un-snooze that chore`, () => snooze(verdict, 0))"
                            @open="(conversationId) => api.chat.openSession(conversationId)"
                        />
                    </RowGroup>
                </template>

                <!-- Record of what was left out (no subject here, a probe that can't run, a broken tool); qualifies the list, so it comes last. -->
                <ScopeNote v-if="only" :probes="only.probes" :inapplicable="only.verdicts.filter((verdict) => verdict.state === `not-applicable`)" />
            </div>
        </template>
    </SplitView>
</template>
