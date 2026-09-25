<script setup lang="ts">
import type { MainlineLand, MainlineRun, MainlineStatus } from "@intentic/sandbox-contract";
import { ui } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { timeAgo } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { openWorkTerminal } from "../../terminal/useWorkTerminals";
import { formatElapsed } from "../fleet/agentStatus";
import { blamedLands, type MainlineSummary, projectName, queuedLands, routingMeta, sinceWhen, verifySession } from "./mainlineView";
import { openLandConversation, useLandTitle } from "./openLanded";

// THE MAIN LINE, OPENED: the main tree's own check in full, docked above the status bar for as long as the reader keeps
// it open. What runs now and whose work it measures, every red with its first failures, whose work they came with and
// who is fixing it, what waits for the next check, and the record. Laid out in columns, since a dock is wide and short.
// Nothing here closes the panel: opening a conversation or a terminal from it leaves it standing, to go on watching.

const t = useT();

const props = defineProps<{
    status: MainlineStatus;
    summary: MainlineSummary;
}>();

// A conversation was opened from here, so a host that is a sheet can get out of the way.
const emit = defineEmits<{ opened: [conversationId: string] }>();

const landTitle = useLandTitle();

// How much of a red run and of the record the panel lists before its terminal is the better place to read.
const FAILURES_SHOWN = 5;
const RECENT_SHOWN = 8;
const SEP = ` · `;

const running = computed(() => props.summary.running);
const queued = computed(() => queuedLands(props.status));
const recent = computed(() => props.status.recent.slice(0, RECENT_SHOWN));

// Open means watched: the running check's elapsed moves by the second, and the record reads the minute it is in.
const now = useNow();
const minute = computed(() => Math.floor(now.value / 60_000) * 60_000);

const failures = (count: number): string => t(`agents.mainline.failures`, { count }, count);

const openNamed = (conversationId: string, title?: string): void => {
    openLandConversation(conversationId, title);
    emit(`opened`, conversationId);
};

const watchCheck = (project: string): void => {
    openWorkTerminal(verifySession(project));
};

// Who a run answered for, by title; a run no land asked for is the sandbox checking again on its own.
const landsLine = (run: MainlineRun): string =>
    run.lands.length === 0 ? t(`agents.mainline.recheck`) : run.lands.map((land: MainlineLand) => landTitle(land.conversationId, land.title)).join(SEP);
</script>

<template>
    <div class="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] items-start gap-x-6 gap-y-3 text-2xs">
        <!-- Now: the check running, or plainly none (one line across the top), so a watcher never infers it from an absence. -->
        <section data-section="now" class="flex min-w-0 flex-col" :class="running === undefined ? `col-span-full` : ``">
            <template v-if="running !== undefined">
                <div class="flex h-6 items-center gap-2">
                    <Icon name="spinner" spin class="shrink-0 text-2xs text-link" />
                    <span class="min-w-0 flex-1 truncate text-xs font-medium text-content">{{
                        t(`agents.mainline.checkingNow`, { project: projectName(running.project) })
                    }}</span>
                    <span class="shrink-0 tabular-nums text-muted">{{ formatElapsed(running.startedAt, now) }}</span>
                    <button
                        type="button"
                        :class="ui.iconButton(`hover:bg-content/10`)"
                        v-tooltip.top="t(`shared.watchInTerminal`)"
                        :aria-label="t(`shared.watchInTerminal`)"
                        @click="watchCheck(running.project)"
                    >
                        <Icon name="desktop" class="text-2xs" />
                    </button>
                </div>
                <p class="truncate pl-4 font-mono text-subtle" v-tooltip.bottom.overflow="running.command">{{ running.command }}</p>
                <p v-if="running.lands.length === 0" class="pt-1 pl-4 text-subtle">{{ t(`agents.mainline.recheck`) }}</p>
                <div v-else class="pt-1 pl-4 text-subtle">{{ t(`agents.mainline.measuring`) }}</div>
                <div
                    v-for="land in running.lands"
                    :key="`${land.conversationId}-${land.at}`"
                    class="-mr-1 flex items-center gap-2 rounded-md py-0.5 pr-1 pl-4 hover:bg-overlay"
                >
                    <span class="min-w-0 flex-1 truncate text-xs text-muted">{{ landTitle(land.conversationId, land.title) }}</span>
                    <button
                        type="button"
                        :class="ui.iconButton(`hover:bg-content/10`)"
                        :aria-label="t(`agents.mainline.openConversation`, { title: landTitle(land.conversationId, land.title) })"
                        @click="openNamed(land.conversationId, land.title)"
                    >
                        <Icon name="arrow-right" class="text-2xs" />
                    </button>
                </div>
            </template>
            <div v-else class="flex h-6 items-center gap-2 text-subtle">
                <Icon name="pause" class="shrink-0 text-2xs" />
                <span class="min-w-0 flex-1 truncate text-xs">{{ t(`agents.mainline.idle`) }}</span>
            </div>
        </section>

        <!-- Every red project, longest first: its first failures, whose work they came with, and who has them. -->
        <section v-for="red in summary.reds" :key="red.project" :data-section="`red-${red.project}`" class="flex min-w-0 flex-col">
            <div class="flex h-6 items-center gap-2">
                <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-danger"></span>
                <span class="min-w-0 flex-1 truncate text-xs font-medium text-danger">{{
                    t(`agents.mainline.redSince`, { project: projectName(red.project), time: sinceWhen(red.since, minute) })
                }}</span>
                <span v-if="red.run.failureCount > 0" class="shrink-0 tabular-nums text-subtle">{{ failures(red.run.failureCount) }}</span>
                <button
                    type="button"
                    :class="ui.iconButton(`hover:bg-content/10`)"
                    v-tooltip.top="t(`shared.watchInTerminal`)"
                    :aria-label="t(`shared.watchInTerminal`)"
                    @click="watchCheck(red.project)"
                >
                    <Icon name="desktop" class="text-2xs" />
                </button>
            </div>
            <ul v-if="red.run.failures.length > 0" class="flex min-w-0 flex-col gap-0.5 pl-4">
                <li
                    v-for="(failure, index) in red.run.failures.slice(0, FAILURES_SHOWN)"
                    :key="index"
                    class="truncate font-mono text-muted"
                    v-tooltip.bottom.overflow="failure"
                >
                    {{ failure }}
                </li>
                <li v-if="red.run.failureCount > FAILURES_SHOWN" class="text-subtle">
                    {{ t(`agents.mainline.moreFailures`, { count: red.run.failureCount - FAILURES_SHOWN }, red.run.failureCount - FAILURES_SHOWN) }}
                </li>
            </ul>
            <p v-else class="pl-4 text-subtle">{{ t(`agents.mainline.noFailureList`) }}</p>
            <div v-if="blamedLands(red.run).length > 0" class="pt-1.5 pl-4 text-subtle">{{ t(`agents.mainline.arrivedWith`) }}</div>
            <div
                v-for="land in blamedLands(red.run)"
                :key="land.conversationId"
                class="-mr-1 flex items-center gap-2 rounded-md py-0.5 pr-1 pl-4 hover:bg-overlay"
            >
                <span class="min-w-0 flex-1 truncate text-xs text-muted">{{ landTitle(land.conversationId, land.title) }}</span>
                <button
                    type="button"
                    :class="ui.iconButton(`hover:bg-content/10`)"
                    :aria-label="t(`agents.mainline.openConversation`, { title: landTitle(land.conversationId, land.title) })"
                    @click="openNamed(land.conversationId, land.title)"
                >
                    <Icon name="arrow-right" class="text-2xs" />
                </button>
            </div>
            <div class="flex items-start gap-2 pt-1.5 pl-4">
                <Icon :name="routingMeta(red.routing?.kind).icon" class="mt-0.5 shrink-0 text-2xs text-muted" />
                <span class="min-w-0 flex-1 leading-relaxed text-muted">
                    <span class="text-content">{{ routingMeta(red.routing?.kind).words }}</span>
                    <template v-if="red.routing?.detail !== undefined">{{ SEP }}{{ red.routing.detail }}</template>
                </span>
                <button
                    v-if="red.routing?.conversationId !== undefined"
                    type="button"
                    :class="ui.linkButton(`shrink-0 gap-1 text-2xs`)"
                    :aria-label="t(`agents.mainline.openConversation`, { title: landTitle(red.routing.conversationId) })"
                    @click="openNamed(red.routing.conversationId)"
                >
                    {{ t(`agents.mainline.open`) }}<Icon name="arrow-right" class="text-2xs" />
                </button>
            </div>
        </section>

        <!-- Lands the next check will measure together. -->
        <section v-if="queued.length > 0" data-section="waiting" class="flex min-w-0 flex-col">
            <div class="flex h-6 items-center gap-2">
                <Icon name="clock" class="shrink-0 text-2xs text-muted" />
                <span class="min-w-0 flex-1 truncate text-xs font-medium text-content">{{ t(`agents.mainline.waitingNext`) }}</span>
            </div>
            <div
                v-for="{ land, project } in queued"
                :key="`${land.conversationId}-${land.at}`"
                class="-mr-1 flex items-center gap-2 rounded-md py-0.5 pr-1 pl-4 hover:bg-overlay"
            >
                <span class="min-w-0 flex-1 truncate text-xs text-muted">{{ landTitle(land.conversationId, land.title) }}</span>
                <span class="shrink-0 text-subtle">{{ projectName(project) }}</span>
                <button
                    type="button"
                    :class="ui.iconButton(`hover:bg-content/10`)"
                    :aria-label="t(`agents.mainline.openConversation`, { title: landTitle(land.conversationId, land.title) })"
                    @click="openNamed(land.conversationId, land.title)"
                >
                    <Icon name="arrow-right" class="text-2xs" />
                </button>
            </div>
        </section>

        <!-- The record, newest first, across every project. -->
        <section v-if="recent.length > 0" data-section="recent" class="flex min-w-0 flex-col">
            <div class="flex h-6 items-center gap-2">
                <Icon name="history" class="shrink-0 text-2xs text-muted" />
                <span class="min-w-0 flex-1 truncate text-xs font-medium text-content">{{ t(`agents.mainline.recentChecks`) }}</span>
            </div>
            <div v-for="run in recent" :key="`${run.project}-${run.at}`" class="flex items-center gap-2 py-0.5 pl-1">
                <span class="h-1.5 w-1.5 shrink-0 rounded-full" :class="run.status === `green` ? `bg-success` : `bg-danger`"></span>
                <span class="shrink-0 text-content">{{ projectName(run.project) }}</span>
                <span class="min-w-0 flex-1 truncate text-subtle" v-tooltip.bottom.overflow="landsLine(run)">{{ landsLine(run) }}</span>
                <span class="shrink-0" :class="run.status === `green` ? `text-success` : `text-danger`">{{
                    run.status === `green` ? t(`agents.mainline.passed`) : t(`agents.mainline.failed`)
                }}</span>
                <span class="shrink-0 tabular-nums text-subtle">{{ timeAgo(run.at, { now: minute, days: true }) }}</span>
            </div>
        </section>
    </div>
</template>
