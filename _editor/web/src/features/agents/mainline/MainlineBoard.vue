<script setup lang="ts">
import type { MainlinePush, MainlineRun, MainlineStatus } from "@intentic/sandbox-contract";
import { ui, useNarrow } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { timeAgo } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import LaneHeader from "../../../components/LaneHeader.vue";
import SandboxOutdatedNotice from "../../sandbox/overview/version/SandboxOutdatedNotice.vue";
import { openWorkTerminal } from "../../terminal/useWorkTerminals";
import { formatElapsed } from "../fleet/agentStatus";
import LandTray from "./LandTray.vue";
import MainlineCard from "./MainlineCard.vue";
import MainlinePushCard from "./MainlinePushCard.vue";
import MainlineRedCard from "./MainlineRedCard.vue";
import {
    checkSession,
    type MainlineEvent,
    type MainlineSummary,
    projectName,
    pushDebtOf,
    queuedLands,
    queuesOf,
    resultDot,
    resultsOf,
    shortSha,
    timelineOf,
    usualBranch,
} from "./mainlineView";
import { useLandTitle } from "./openLanded";

// THE MAIN LINE AS A BOARD, drawn the way the fleet board is (AgentsView): lanes side by side under the board's own lane
// headers, cards in them, and the lanes stacked with their headers pinned once the view is too narrow for three. The
// lanes are the road a land travels, left to right: Queued (each project's lands, waiting for its next check to measure
// them together) → Checking (the one check running, with the lands it measures hung under it) → Result (where each
// project stands: a failing one first, with who has it and what failed; then what pushes left; then the passing ones).
//
// The record is the Result lane's other side, opened from its header the way the fleet board's Finished lane opens its
// archive: the lane swaps its name and its cards for History (every check and push, newest first) and grows a way back.
// Every lane is drawn in every state, an empty one as one muted line, so each thing has one place to be looked for and
// nothing moves when main changes. It explains nothing on hover: a land opens its conversation, "Logs" opens a check's
// terminal, and a red says in one line who has it.

const t = useT();

const props = defineProps<{
    status: MainlineStatus;
    summary: MainlineSummary;
}>();

const landTitle = useLandTitle();

// The fleet board's own width for stacking its lanes, measured the same way (useNarrow).
const NARROW_BOARD_REM = 48;
const board = ref<HTMLElement | undefined>(undefined);
const narrow = useNarrow(board, NARROW_BOARD_REM);

// Open means watched: the running check's clock moves by the second, and every age on the board reads the same minute.
const now = useNow();
const minute = computed(() => Math.floor(now.value / 60_000) * 60_000);

// A lane's header sits 4px inside its cards, as the fleet board's does, and pins while the stacked board scrolls under it.
const head = computed(() => [`px-1`, narrow.value ? `sticky top-0 z-10 rounded-t-xl bg-canvas` : ``]);
const EMPTY = `px-1 pb-3 text-2xs text-subtle`;

const queues = computed(() => queuesOf(props.status));
const queued = computed(() => queuedLands(props.status).length);
const running = computed(() => props.summary.running);

// A sandbox too old to name its check's terminal offers no Logs rather than a guess at one; while a project is checked
// again its one terminal opens from the running check, so its result card offers none.
const logsOf = (project: string, from: `check` | `result`): (() => void) | undefined => {
    const session = checkSession(props.status, project);
    if (session === undefined || (from === `result` && running.value?.project === project)) {
        return undefined;
    }
    return () => openWorkTerminal(session);
};
const checkLogs = computed(() => (running.value === undefined ? undefined : logsOf(running.value.project, `check`)));

// The Result lane, in the order a reader is owed it: the reds (longest first), what pushes left (most first), then every
// project whose last check passed, or failed on a sandbox too old to say more than that.
const results = computed(() => resultsOf(props.status));
const reds = computed(() => results.value.flatMap((result) => (result.red === undefined ? [] : [result.red])));
const debts = computed(() => pushDebtOf(props.status));
const settled = computed(() => results.value.filter((result) => result.red === undefined));

// THE RECORD, lands' checks and pushes side by side, newest first: all of it the daemon keeps, a lane's worth at a time.
const RECORD_KEPT = 200;
const RECORD_SHOWN = 12;
const record = computed(() => timelineOf(props.status, RECORD_KEPT));
const history = ref(false);
const recordAll = ref(false);
const recordShown = computed(() => (recordAll.value ? record.value : record.value.slice(0, RECORD_SHOWN)));
const recordHidden = computed(() => record.value.length - RECORD_SHOWN);
const openHistory = (): void => {
    history.value = true;
};
const closeHistory = (): void => {
    history.value = false;
    recordAll.value = false;
};

// A record's project is worth naming only when there is more than one it could be, counting the ones only pushes came from.
const manyProjects = computed(() => new Set([...props.status.projects, ...(props.status.pushed ?? [])].map(({ project }) => project)).size > 1);

// What a settled run measured: its first land by title and a count of the rest, or a re-check no land asked for.
const measured = (run: MainlineRun): string => {
    const [first] = run.lands;
    if (first === undefined) {
        return t(`agents.mainline.recheck`);
    }
    const title = landTitle(first.conversationId, first.title);
    return run.lands.length === 1 ? title : t(`agents.mainline.andMore`, { title, count: run.lands.length - 1 });
};

// The branch the record's pushes go to, which no card repeats (usualBranch).
const usual = computed(() => usualBranch(props.status));
const pushTitle = (push: MainlinePush): string =>
    push.branch === undefined || push.branch === usual.value ? shortSha(push.head) : `${shortSha(push.head)} → ${push.branch}`;

// What a push left, as the record says it: still standing, all of it since settled, or nothing at all.
const pushOutcome = (event: Extract<MainlineEvent, { kind: `push` }>): { readonly words: string; readonly ink: string; readonly tone: `warning` | `success` | `neutral` } =>
    event.open > 0
        ? { words: t(`agents.mainline.push.left`, { count: event.open }, event.open), ink: `text-warning`, tone: `warning` }
        : event.handled
          ? { words: t(`agents.mainline.push.handled`), ink: `text-muted`, tone: `neutral` }
          : { words: t(`agents.mainline.push.clean`), ink: `text-success`, tone: `success` };

const eventKey = (event: MainlineEvent): string => (event.kind === `land` ? `land-${event.run.project}-${event.run.at}` : `push-${event.push.id}`);
</script>

<template>
    <!-- No padding of its own: the stacked board's pinned lane headers sit at top-0, and padding would leave a gap above them. -->
    <div ref="board" class="scrollbar-stable min-h-0 flex-1 overflow-auto">
        <!-- A sandbox too old for this board: said once, above the lanes, which then show only what it did serve. -->
        <div v-if="summary.outdated" class="px-3.5 pt-3.5 sm:px-4 sm:pt-4" :class="narrow ? `` : `lg:px-6 lg:pt-6`">
            <SandboxOutdatedNotice :missing="t(`agents.mainline.outdatedMissing`)" />
        </div>
        <!-- `content-start` stops the stacked grid's rows from stretching, which would float a lane's cards above the next header. -->
        <div class="grid gap-3.5 p-3.5 sm:gap-4 sm:p-4" :class="narrow ? `content-start` : `grid-cols-3 items-start lg:gap-6 lg:p-6`">
            <!-- What landed and waits, per project: the next check measures each project's lands together. -->
            <section data-lane="queued" class="flex min-w-0 flex-col">
                <LaneHeader :label="t(`agents.mainline.columnQueued`)" dot="bg-line-strong" :count="queued > 0 ? queued : undefined" :class="head" />
                <p v-if="queues.length === 0" :class="EMPTY">{{ t(`agents.mainline.nothingQueued`) }}</p>
                <div v-else class="flex flex-col gap-3.5 pb-2.5">
                    <div v-for="queue in queues" :key="queue.project" :data-queue="queue.project" class="flex flex-col">
                        <MainlineCard :title="projectName(queue.project)" icon="clock">
                            <template #meta>
                                <span class="min-w-0 truncate">{{ t(`agents.mainline.board.waiting`, { count: queue.lands.length }, queue.lands.length) }}</span>
                            </template>
                        </MainlineCard>
                        <LandTray
                            :lands="queue.lands"
                            :label="t(`agents.mainline.board.queuedLands`, { project: projectName(queue.project) })"
                            waiting
                            :minute="minute"
                        />
                    </div>
                </div>
            </section>

            <!-- The one check running, on one project at a time, with the work it measures hung under it. -->
            <section data-lane="checking" class="flex min-w-0 flex-col">
                <LaneHeader :label="t(`agents.mainline.columnChecking`)" dot="bg-link" :class="head" />
                <p v-if="running === undefined" :class="EMPTY">{{ t(`agents.mainline.board.idle`) }}</p>
                <div v-else :data-check="running.project" class="flex flex-col pb-2.5">
                    <MainlineCard :title="projectName(running.project)" icon="spinner" spin tone="link" live>
                        <template #meta>
                            <span class="min-w-0 truncate">{{
                                running.lands.length === 0
                                    ? t(`agents.mainline.recheck`)
                                    : t(`agents.mainline.board.measuring`, { count: running.lands.length }, running.lands.length)
                            }}</span>
                            <span v-if="running.on !== undefined" class="min-w-0 truncate">· {{ t(`agents.mainline.board.on`, { machine: running.on }) }}</span>
                        </template>
                        <template #trailing>
                            <span class="shrink-0 text-xs font-medium tabular-nums text-link">{{ formatElapsed(running.startedAt, now) }}</span>
                        </template>
                        <div v-if="checkLogs !== undefined" class="flex min-w-0 items-center">
                            <button type="button" :class="ui.textAction(`gap-1 text-2xs`)" @click="checkLogs()">
                                <Icon name="terminal" class="text-2xs" />{{ t(`agents.mainline.logs`) }}
                            </button>
                        </div>
                    </MainlineCard>
                    <LandTray
                        v-if="running.lands.length > 0"
                        :lands="running.lands"
                        :label="t(`agents.mainline.board.measuredLands`, { project: projectName(running.project) })"
                        live
                        :minute="minute"
                    />
                </div>
            </section>

            <!-- Where each project stands after its last check, and what pushes left; or, opened from its header, the record. -->
            <section data-lane="result" class="flex min-w-0 flex-col">
                <LaneHeader :label="t(`agents.mainline.columnResult`)" :dot="resultDot(results)" :count="history ? record.length : undefined" :class="head">
                    <template v-if="history" #mark>
                        <button
                            type="button"
                            :aria-label="t(`agents.mainline.board.backToResults`)"
                            v-tooltip.bottom="t(`agents.mainline.board.backToResults`)"
                            :class="ui.iconButton(`h-4 w-4 rounded`)"
                            @click="closeHistory"
                        >
                            <Icon name="arrow-left" class="text-2xs" />
                        </button>
                        <span class="text-2xs font-semibold uppercase tracking-wide text-muted">{{ t(`agents.mainline.columnHistory`) }}</span>
                    </template>
                    <template v-if="!history && record.length > 0" #actions>
                        <button
                            type="button"
                            data-history
                            :aria-label="t(`agents.mainline.board.openHistory`, { count: record.length })"
                            v-tooltip.bottom="t(`agents.mainline.board.historyHint`)"
                            class="ui-chip shrink-0 gap-1"
                            @click="openHistory"
                        >
                            <Icon name="history" class="text-2xs" />{{ record.length }}
                        </button>
                    </template>
                </LaneHeader>

                <template v-if="!history">
                    <p v-if="results.length === 0 && debts.length === 0" :class="EMPTY">{{ t(`agents.mainline.noResults`) }}</p>
                    <div v-else class="flex flex-col gap-3.5 pb-2.5">
                        <MainlineRedCard v-for="red in reds" :key="`red-${red.project}`" :red="red" :logs="logsOf(red.project, `result`)" :minute="minute" />
                        <MainlinePushCard v-for="debt in debts" :key="`push-${debt.project}`" :debt="debt" :minute="minute" />
                        <MainlineCard
                            v-for="result in settled"
                            :key="`result-${result.project}`"
                            :data-result="result.project"
                            :title="projectName(result.project)"
                            :icon="result.run.status === `green` ? `check` : `times`"
                            :tone="result.run.status === `green` ? `success` : `danger`"
                        >
                            <template #meta>
                                <span class="shrink-0" :class="result.run.status === `green` ? `text-success` : `text-danger`">{{
                                    result.run.status === `green` ? t(`agents.mainline.passing`) : t(`agents.mainline.failing`)
                                }}</span>
                                <span class="shrink-0">·</span>
                                <span class="min-w-0 truncate">{{ measured(result.run) }}</span>
                            </template>
                            <template #trailing>
                                <span class="shrink-0 text-2xs tabular-nums text-subtle">{{ timeAgo(result.run.at, { now: minute, days: true }) }}</span>
                            </template>
                        </MainlineCard>
                    </div>
                </template>

                <!-- THE RECORD: every check a land asked for, or the sandbox ran again, and every push the hook measured. -->
                <div v-else data-history-list class="flex flex-col gap-2 pb-2.5">
                    <template v-for="event in recordShown" :key="eventKey(event)">
                        <MainlineCard
                            v-if="event.kind === `land`"
                            data-event="land"
                            :title="measured(event.run)"
                            :icon="event.run.status === `green` ? `check` : `times`"
                            :tone="event.run.status === `green` ? `success` : `danger`"
                        >
                            <template #meta>
                                <span class="shrink-0" :class="event.run.status === `green` ? `text-success` : `text-danger`">{{
                                    event.run.status === `green` ? t(`agents.mainline.passed`) : t(`agents.mainline.failed`)
                                }}</span>
                                <template v-if="manyProjects">
                                    <span class="shrink-0">·</span>
                                    <span class="min-w-0 truncate">{{ projectName(event.run.project) }}</span>
                                </template>
                            </template>
                            <template #trailing>
                                <span class="shrink-0 text-2xs tabular-nums text-subtle">{{ timeAgo(event.run.at, { now: minute, days: true }) }}</span>
                            </template>
                        </MainlineCard>
                        <MainlineCard v-else data-event="push" :title="pushTitle(event.push)" mono icon="arrow-up-right" :tone="pushOutcome(event).tone">
                            <template #meta>
                                <span class="shrink-0" :class="pushOutcome(event).ink">{{ pushOutcome(event).words }}</span>
                                <template v-if="manyProjects">
                                    <span class="shrink-0">·</span>
                                    <span class="min-w-0 truncate">{{ projectName(event.push.project) }}</span>
                                </template>
                            </template>
                            <template #trailing>
                                <span class="shrink-0 text-2xs tabular-nums text-subtle">{{ timeAgo(event.push.at, { now: minute, days: true }) }}</span>
                            </template>
                        </MainlineCard>
                    </template>
                    <!-- The record's tail, not a pager: the count is the point, and the rest stay one press away. -->
                    <button v-if="recordHidden > 0 && !recordAll" type="button" :class="ui.addTile(`gap-1.5 rounded-lg py-2 text-2xs`)" @click="recordAll = true">
                        <Icon name="chevron-down" class="text-2xs" />
                        {{ t(`ui.action.showEarlier`, { count: recordHidden }) }}
                    </button>
                </div>
            </section>
        </div>
    </div>
</template>
