<script setup lang="ts">
import type { MainlineRun, MainlineStatus } from "@intentic/sandbox-contract";
import { ui } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { timeAgo } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { openWorkTerminal } from "../../terminal/useWorkTerminals";
import { formatElapsed } from "../fleet/agentStatus";
import {
    causeOf,
    failureParts,
    fixTone,
    type MainlineSummary,
    projectName,
    queuedLands,
    resultsOf,
    routingMeta,
    sinceWhen,
    verifySession,
} from "./mainlineView";
import { openLandConversation, useLandTitle } from "./openLanded";

// THE MAIN LINE, OPENED, drawn as the road a land travels: Queued → Checking → Result, left to right, with the record
// beside it. Every column is drawn in every state, an empty one as one muted line, so each thing has one place to be
// looked for and nothing moves when main changes. It explains nothing on hover: a title opens its conversation, "Logs"
// opens the check's terminal, and a red says in one line who has it.
// Nothing here closes the panel: opening a conversation or a terminal from it leaves it standing, to go on watching.

const t = useT();

const props = defineProps<{
    status: MainlineStatus;
    summary: MainlineSummary;
}>();

// A conversation was opened from here, so a host that is a sheet can get out of the way.
const emit = defineEmits<{ opened: [conversationId: string] }>();

const landTitle = useLandTitle();

// How much of a red run and of the record the panel lists before the terminal is the better place to read.
const FAILURES_SHOWN = 3;
const RECENT_SHOWN = 8;

const HEADING = `flex h-5 items-center gap-1.5 text-2xs font-semibold uppercase tracking-wide text-subtle`;
// A land's title, which opens its conversation: the whole row is the press.
const LAND = `-mx-1.5 flex min-w-0 items-center gap-2 rounded-md px-1.5 py-0.5 text-left text-xs text-muted transition-colors hover:bg-overlay hover:text-content`;

const running = computed(() => props.summary.running);
const queued = computed(() => queuedLands(props.status));
const recent = computed(() => props.status.recent.slice(0, RECENT_SHOWN));
// A land's project is worth naming only when there is more than one it could be.
const manyProjects = computed(() => props.status.projects.length > 1);

// Each project's standing, a red one with the work it is laid at and the one line on who has it.
const results = computed(() =>
    resultsOf(props.status).map((result) => {
        if (result.red === undefined) {
            return { ...result, cause: [], fix: undefined };
        }
        const meta = routingMeta(result.red.routing?.kind);
        // The conversation the line names: the one fixing it, or the one it waits for.
        const conversationId = meta.lead === undefined ? undefined : result.red.routing?.conversationId;
        // Why nobody was sent is worth its sentence only when it leaves the red to the reader.
        const detail = meta.state === `needs-you` ? result.red.routing?.detail : undefined;
        return { ...result, cause: causeOf(props.status, result.red), fix: { meta, conversationId, detail } };
    }),
);

// Open means watched: the running check's elapsed moves by the second, and the record reads the minute it is in.
const now = useNow();
const minute = computed(() => Math.floor(now.value / 60_000) * 60_000);

const open = (conversationId: string, title?: string): void => {
    openLandConversation(conversationId, title);
    emit(`opened`, conversationId);
};

const showLogs = (project: string): void => {
    openWorkTerminal(verifySession(project));
};

// What a settled run measured: its first land by title and a count of the rest, or a re-check no land asked for.
const measured = (run: MainlineRun): string => {
    const [first] = run.lands;
    if (first === undefined) {
        return t(`agents.mainline.recheck`);
    }
    const title = landTitle(first.conversationId, first.title);
    return run.lands.length === 1 ? title : t(`agents.mainline.andMore`, { title, count: run.lands.length - 1 });
};
</script>

<template>
    <div class="@container">
        <!-- Four columns when the dock is wide. Narrower, the two short ones stack beside the result, so what main's state is
             stays in view, and the record goes under them. -->
        <div
            class="grid grid-cols-1 gap-x-8 gap-y-5 pt-1 @xl:grid-cols-2 @4xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.5fr)_minmax(0,1.2fr)]"
        >
            <div class="flex min-w-0 flex-col gap-5 @4xl:contents">
                <!-- What landed and waits: the next check measures all of it together. -->
                <section data-section="queued" class="flex min-w-0 flex-col gap-1">
                    <h4 :class="HEADING">
                        {{ t(`agents.mainline.columnQueued`) }}
                        <span v-if="queued.length > 0" class="tabular-nums text-muted">{{ queued.length }}</span>
                    </h4>
                    <p v-if="queued.length === 0" class="text-xs text-subtle">{{ t(`agents.mainline.nothingQueued`) }}</p>
                    <button
                        v-for="{ land, project } in queued"
                        :key="`${land.conversationId}-${land.at}`"
                        type="button"
                        :class="LAND"
                        @click="open(land.conversationId, land.title)"
                    >
                        <span class="min-w-0 flex-1 truncate">{{ landTitle(land.conversationId, land.title) }}</span>
                        <span v-if="manyProjects" class="max-w-[40%] shrink-0 truncate text-2xs text-subtle">{{ projectName(project) }}</span>
                    </button>
                </section>

                <!-- The one check running, on one project at a time, and the work it measures. -->
                <section data-section="checking" class="flex min-w-0 flex-col gap-1">
                    <h4 :class="HEADING">
                        <Icon name="arrow-right" class="shrink-0 text-2xs" />
                        {{ t(`agents.mainline.columnChecking`) }}
                    </h4>
                    <template v-if="running !== undefined">
                        <div class="flex h-6 min-w-0 items-center gap-2 text-xs">
                            <Icon name="spinner" spin class="shrink-0 text-2xs text-link" />
                            <span class="min-w-0 truncate font-medium text-content">{{ projectName(running.project) }}</span>
                            <span class="shrink-0 tabular-nums text-muted">{{ formatElapsed(running.startedAt, now) }}</span>
                            <button type="button" :class="ui.textAction(`ml-auto shrink-0 gap-1 text-2xs`)" @click="showLogs(running.project)">
                                <Icon name="terminal" class="text-2xs" />{{ t(`agents.mainline.logs`) }}
                            </button>
                        </div>
                        <div class="flex min-w-0 flex-col pl-4">
                            <p v-if="running.lands.length === 0" class="text-xs text-subtle">{{ t(`agents.mainline.recheck`) }}</p>
                            <button
                                v-for="land in running.lands"
                                :key="`${land.conversationId}-${land.at}`"
                                type="button"
                                :class="LAND"
                                @click="open(land.conversationId, land.title)"
                            >
                                <span class="min-w-0 flex-1 truncate">{{ landTitle(land.conversationId, land.title) }}</span>
                            </button>
                        </div>
                    </template>
                    <p v-else class="text-xs text-subtle">{{ t(`agents.mainline.idle`) }}</p>
                </section>
            </div>

            <!-- Where each project stands after its last check; a failing one with what failed, why, and who has it. -->
            <section data-section="result" class="flex min-w-0 flex-col gap-1">
                <h4 :class="HEADING">
                    <Icon name="arrow-right" class="shrink-0 text-2xs" />
                    {{ t(`agents.mainline.columnResult`) }}
                </h4>
                <p v-if="results.length === 0" class="text-xs text-subtle">{{ t(`agents.mainline.noResults`) }}</p>
                <template v-for="result in results" :key="result.project">
                    <div
                        v-if="result.red !== undefined && result.fix !== undefined"
                        :data-result="result.project"
                        class="flex min-w-0 flex-col gap-1 pb-1"
                    >
                        <div class="flex h-6 min-w-0 items-center gap-2 text-xs">
                            <Icon name="times" class="shrink-0 text-2xs text-danger" />
                            <span class="min-w-0 truncate font-medium text-content">{{ projectName(result.project) }}</span>
                            <span class="shrink-0 text-danger">{{
                                t(`agents.mainline.failingSince`, { time: sinceWhen(result.red.since, minute) })
                            }}</span>
                            <!-- One terminal per project: while it is being checked again, the Checking column already opens it. -->
                            <button
                                v-if="running?.project !== result.project"
                                type="button"
                                :class="ui.textAction(`ml-auto shrink-0 gap-1 text-2xs`)"
                                @click="showLogs(result.project)"
                            >
                                <Icon name="terminal" class="text-2xs" />{{ t(`agents.mainline.logs`) }}
                            </button>
                        </div>
                        <!-- Read in the order it is needed: who has it, what broke it, then what failed. -->
                        <div class="flex min-w-0 flex-col gap-1.5 pl-4">
                            <div data-fix class="flex min-w-0 items-center gap-1.5 text-xs" :class="fixTone(result.fix.meta.state)">
                                <Icon :name="result.fix.meta.icon" class="shrink-0 text-2xs" />
                                <template v-if="result.fix.conversationId !== undefined">
                                    <span class="shrink-0">{{ result.fix.meta.lead }}</span>
                                    <button type="button" :class="ui.linkButton(`min-w-0 text-xs`)" @click="open(result.fix.conversationId)">
                                        <span class="truncate">{{ landTitle(result.fix.conversationId) }}</span>
                                    </button>
                                </template>
                                <span v-else class="min-w-0 truncate">{{ result.fix.meta.words }}</span>
                            </div>
                            <p v-if="result.fix.detail !== undefined" class="-mt-1 pl-4 text-2xs text-subtle">{{ result.fix.detail }}</p>
                            <div v-if="result.cause.length > 0" data-cause class="flex min-w-0 flex-wrap items-center gap-x-2 text-xs">
                                <span class="shrink-0 text-subtle">{{ t(`agents.mainline.likelyCause`) }}</span>
                                <!-- The comma rides with the title before it, so a list that wraps never starts a line with one. -->
                                <span
                                    v-for="(land, index) in result.cause"
                                    :key="land.conversationId"
                                    class="flex min-w-0 max-w-full items-center text-subtle"
                                >
                                    <button type="button" :class="ui.linkButton(`min-w-0 text-xs`)" @click="open(land.conversationId, land.title)">
                                        <span class="truncate">{{ landTitle(land.conversationId, land.title) }}</span>
                                    </button>
                                    <template v-if="index < result.cause.length - 1">,</template>
                                </span>
                            </div>
                            <ul v-if="result.run.failures.length > 0" data-failures class="flex min-w-0 flex-col gap-0.5">
                                <li
                                    v-for="(failure, index) in result.run.failures.slice(0, FAILURES_SHOWN).map(failureParts)"
                                    :key="index"
                                    class="line-clamp-2 text-2xs wrap-anywhere"
                                >
                                    <span class="text-muted" :class="failure.file === undefined ? `font-mono` : ``">{{ failure.name }}</span>
                                    <span v-if="failure.file !== undefined" class="ml-1.5 font-mono text-subtle">{{ failure.file }}</span>
                                </li>
                                <li v-if="result.run.failureCount > FAILURES_SHOWN" class="text-2xs text-subtle">
                                    {{ t(`agents.mainline.moreFailures`, { count: result.run.failureCount - FAILURES_SHOWN }) }}
                                </li>
                            </ul>
                            <p v-else class="text-2xs text-subtle">{{ t(`agents.mainline.noFailureList`) }}</p>
                        </div>
                    </div>
                    <div v-else :data-result="result.project" class="flex h-6 min-w-0 items-center gap-2 text-xs">
                        <Icon
                            :name="result.run.status === `green` ? `check` : `times`"
                            class="shrink-0 text-2xs"
                            :class="result.run.status === `green` ? `text-success` : `text-danger`"
                        />
                        <span class="min-w-0 truncate font-medium text-content">{{ projectName(result.project) }}</span>
                        <span class="shrink-0" :class="result.run.status === `green` ? `text-muted` : `text-danger`">{{
                            result.run.status === `green` ? t(`agents.mainline.passing`) : t(`agents.mainline.failing`)
                        }}</span>
                        <span class="ml-auto shrink-0 tabular-nums text-2xs text-subtle">{{
                            timeAgo(result.run.at, { now: minute, days: true })
                        }}</span>
                    </div>
                </template>
            </section>

            <!-- The record, newest first across every project: outside the road, so set apart from it. -->
            <section
                v-if="recent.length > 0"
                data-section="history"
                class="flex min-w-0 flex-col gap-1 @xl:col-span-2 @4xl:col-span-1 @4xl:border-l @4xl:border-line-subtle @4xl:pl-8"
            >
                <h4 :class="HEADING">{{ t(`agents.mainline.columnHistory`) }}</h4>
                <div v-for="run in recent" :key="`${run.project}-${run.at}`" class="flex h-6 min-w-0 items-center gap-2 text-xs">
                    <Icon
                        :name="run.status === `green` ? `check` : `times`"
                        class="shrink-0 text-2xs"
                        :class="run.status === `green` ? `text-success` : `text-danger`"
                    />
                    <span class="sr-only">{{ run.status === `green` ? t(`agents.mainline.passed`) : t(`agents.mainline.failed`) }}</span>
                    <span class="min-w-0 flex-1 truncate text-muted">{{ measured(run) }}</span>
                    <span v-if="manyProjects" class="max-w-[35%] shrink-0 truncate text-2xs text-subtle">{{ projectName(run.project) }}</span>
                    <span class="shrink-0 tabular-nums text-2xs text-subtle">{{ timeAgo(run.at, { now: minute, days: true }) }}</span>
                </div>
            </section>
        </div>
    </div>
</template>
