<script setup lang="ts">
import type { MainlineLand, MainlineRouting, MainlineRun, MainlineStatus } from "@intentic/sandbox-contract";
import { AnchoredOverlay, ui } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { timeAgo } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { openWorkTerminal } from "../../terminal/useWorkTerminals";
import { formatElapsed } from "../fleet/agentStatus";
import { useAgents } from "../fleet/useAgents";
import {
    blamedLands,
    type MainlineHeadline,
    mainlineHeadline,
    projectName,
    queuedLands,
    redsOf,
    routingMeta,
    sinceWhen,
    verifySession,
} from "./mainlineView";
import { openLandConversation } from "./openLanded";

// THE MAIN LINE, ALWAYS IN VIEW. Work lands without waiting for any check now, and the main tree's own check runs
// afterwards; this is where a reader sees it running, sees it red and who is fixing it, and opens the rest. The rail
// draws it as a block over its lanes, the board as a bar under its header. Absent while no land was ever checked.

const t = useT();

const props = defineProps<{
    status: MainlineStatus | undefined;
    // The board's full-width bar under its header; the rail's boxed block otherwise.
    bar?: boolean;
}>();

// A conversation was opened from here, so a host that is a sheet can get out of the way.
const emit = defineEmits<{ opened: [conversationId: string] }>();

const { agentById } = useAgents();

// How much of a red run and of the record the popover lists before its terminal is the better place to read.
const FAILURES_SHOWN = 5;
const RECENT_SHOWN = 5;
const SEP = ` · `;

const headline = computed<MainlineHeadline | undefined>(() => mainlineHeadline(props.status));
const reds = computed(() => (props.status === undefined ? [] : redsOf(props.status)));
const worst = computed(() => reds.value[0]);
const queued = computed(() => (props.status === undefined ? [] : queuedLands(props.status)));
const running = computed(() => props.status?.projects.find((project) => project.running !== undefined));
const recent = computed(() => props.status?.recent.slice(0, RECENT_SHOWN) ?? []);

const trigger = ref<HTMLButtonElement | null>(null);
const open = ref(false);

// Armed only while something drawn moves with time: a running check's elapsed, every second; a green "checked 5m ago"
// and the popover's record, which read the minute they are in and so redraw once a minute rather than with every tick.
// A red line names the wall-clock minute it began, which never needs one.
const now = useNow(() => headline.value?.kind === `running` || headline.value?.kind === `green` || open.value);
const minute = computed(() => Math.floor(now.value / 60_000) * 60_000);

const landsWords = (count: number): string => t(`agents.mainline.lands`, { count }, count);
const failures = (count: number): string => t(`agents.mainline.failures`, { count }, count);

const line = computed<string>(() => {
    const head = headline.value;
    if (head === undefined) {
        return ``;
    }
    if (head.kind === `running`) {
        return [t(`agents.mainline.checkingMain`), projectName(head.project), landsWords(head.lands), formatElapsed(head.startedAt, now.value)].join(SEP);
    }
    if (head.kind === `red`) {
        return [
            t(`agents.mainline.mainRed`),
            projectName(head.project),
            ...(head.failures > 0 ? [failures(head.failures)] : []),
            t(`agents.mainline.since`, { time: sinceWhen(head.since, minute.value) }),
        ].join(SEP);
    }
    if (head.kind === `queued`) {
        return t(`agents.mainline.landsWaiting`, { count: head.lands }, head.lands);
    }
    return [t(`agents.mainline.mainGreen`), t(`agents.mainline.checkedAgo`, { ago: timeAgo(head.at, { now: minute.value, days: true }) })].join(SEP);
});

const DOT: Record<MainlineHeadline[`kind`], string> = {
    running: `bg-link motion-safe:animate-pulse`,
    red: `bg-danger`,
    queued: `bg-subtle`,
    green: `bg-success`,
};
const INK: Record<MainlineHeadline[`kind`], string> = { running: `text-content`, red: `text-danger`, queued: `text-muted`, green: `text-muted` };

// A red the headline does not lead with (a check is running, elsewhere or on it) still says so on the same line.
const alsoRed = computed(() =>
    worst.value === undefined || headline.value?.kind === `red` ? undefined : t(`agents.mainline.alsoRed`, { project: projectName(worst.value.project) }),
);
const routing = computed(() => (worst.value === undefined ? undefined : routingMeta(worst.value.routing?.kind)));

const titleOf = (conversationId: string, title?: string): string => title ?? agentById(conversationId)?.title ?? conversationId;

const openNamed = (conversationId: string, title?: string): void => {
    open.value = false;
    openLandConversation(conversationId, title ?? agentById(conversationId)?.title);
    emit(`opened`, conversationId);
};

// Handed the whole routing rather than its id, so a press never has to trust a narrowing made outside it.
const openRouted = (decided: MainlineRouting | undefined): void => {
    if (decided?.conversationId !== undefined) {
        openNamed(decided.conversationId);
    }
};

const watchCheck = (project: string | undefined): void => {
    if (project === undefined) {
        return;
    }
    open.value = false;
    openWorkTerminal(verifySession(project));
};

// Who a run answered for, by title; a run no land asked for is the sandbox checking again on its own.
const landsLine = (run: MainlineRun): string =>
    run.lands.length === 0 ? t(`agents.mainline.recheck`) : run.lands.map((land: MainlineLand) => titleOf(land.conversationId, land.title)).join(SEP);
</script>

<template>
    <div
        v-if="headline !== undefined"
        role="group"
        :aria-label="t(`agents.mainline.title`)"
        class="flex shrink-0 text-2xs"
        :class="[
            bar ? `flex-wrap items-center gap-x-4 gap-y-1 border-b border-line px-3 py-1.5` : `flex-col gap-1.5 rounded-lg border px-2.5 py-2`,
            bar ? (worst === undefined ? `` : `bg-danger/10`) : worst === undefined ? `border-line` : `border-danger/40 bg-danger/10`,
        ]"
    >
        <button
            ref="trigger"
            type="button"
            class="flex min-w-0 items-center gap-1.5 text-left"
            :class="bar ? `` : `w-full`"
            :aria-expanded="open"
            aria-haspopup="dialog"
            @click="open = !open"
        >
            <span class="h-1.5 w-1.5 shrink-0 rounded-full" :class="DOT[headline.kind]"></span>
            <span class="min-w-0 flex-1 font-medium leading-snug tabular-nums" :class="INK[headline.kind]">{{ line }}</span>
            <span v-if="alsoRed !== undefined" class="shrink-0 font-medium text-danger">{{ alsoRed }}</span>
            <Icon name="chevron-down" class="shrink-0 text-2xs text-subtle transition-transform" :class="{ 'rotate-180': open }" />
        </button>

        <!-- Who has the red, said at rest: the one thing about it a reader can act on is which conversation to open. -->
        <div v-if="worst !== undefined && routing !== undefined" class="flex min-w-0 items-center gap-1.5 text-muted">
            <Icon :name="routing.icon" class="shrink-0 text-2xs" />
            <span class="min-w-0 leading-snug" :class="bar ? `` : `flex-1`" v-tooltip.bottom="worst.routing?.detail">{{ routing.words }}</span>
            <button
                v-if="worst.routing?.conversationId !== undefined"
                type="button"
                :class="ui.linkButton(`shrink-0 gap-1 text-2xs`)"
                :aria-label="t(`agents.mainline.openConversation`, { title: titleOf(worst.routing.conversationId) })"
                @click="openRouted(worst?.routing)"
            >
                {{ t(`agents.mainline.open`) }}<Icon name="arrow-right" class="text-2xs" />
            </button>
        </div>

        <AnchoredOverlay v-model="open" :anchor="trigger ?? undefined" side="bottom" cross="start">
            <div class="flex min-h-0 w-80 flex-col overflow-y-auto p-1">
                <div class="px-2 py-1.5 text-2xs font-medium uppercase tracking-wide text-muted">{{ t(`agents.mainline.title`) }}</div>

                <!-- The check running now, and what it answers for. -->
                <section v-if="running?.running !== undefined" class="flex flex-col pb-1">
                    <div class="flex items-center gap-2 px-2 py-1">
                        <Icon name="spinner" spin class="shrink-0 text-2xs text-link" />
                        <span class="min-w-0 flex-1 truncate text-xs text-content">{{
                            t(`agents.mainline.checkingNow`, { project: projectName(running.project) })
                        }}</span>
                        <span class="shrink-0 text-2xs tabular-nums text-subtle">{{ formatElapsed(running.running.startedAt, now) }}</span>
                        <button
                            type="button"
                            :class="ui.iconButton(`hover:bg-content/10`)"
                            v-tooltip.top="t(`shared.watchInTerminal`)"
                            :aria-label="t(`shared.watchInTerminal`)"
                            @click="watchCheck(running?.project)"
                        >
                            <Icon name="desktop" class="text-2xs" />
                        </button>
                    </div>
                    <p class="truncate px-2 pl-6 font-mono text-2xs text-subtle" v-tooltip.bottom.overflow="running.running.command">
                        {{ running.running.command }}
                    </p>
                    <div
                        v-for="land in running.running.lands"
                        :key="`${land.conversationId}-${land.at}`"
                        class="flex items-center gap-2 rounded-md py-0.5 pr-2 pl-6 hover:bg-overlay"
                    >
                        <span class="min-w-0 flex-1 truncate text-xs text-muted">{{ titleOf(land.conversationId, land.title) }}</span>
                        <button
                            type="button"
                            :class="ui.iconButton(`hover:bg-content/10`)"
                            :aria-label="t(`agents.mainline.openConversation`, { title: titleOf(land.conversationId, land.title) })"
                            @click="openNamed(land.conversationId, land.title)"
                        >
                            <Icon name="arrow-right" class="text-2xs" />
                        </button>
                    </div>
                </section>

                <!-- Every red project, longest first: its first failures, and who has them. -->
                <section v-for="red in reds" :key="red.project" class="flex flex-col border-t border-line-subtle py-1">
                    <div class="flex items-center gap-2 px-2 py-1">
                        <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-danger"></span>
                        <span class="min-w-0 flex-1 truncate text-xs font-medium text-danger">{{
                            t(`agents.mainline.redSince`, { project: projectName(red.project), time: sinceWhen(red.since, minute) })
                        }}</span>
                        <span v-if="red.run.failureCount > 0" class="shrink-0 text-2xs tabular-nums text-subtle">{{ failures(red.run.failureCount) }}</span>
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
                    <ul v-if="red.run.failures.length > 0" class="flex min-w-0 flex-col gap-0.5 pr-2 pl-6">
                        <li
                            v-for="(failure, index) in red.run.failures.slice(0, FAILURES_SHOWN)"
                            :key="index"
                            class="truncate font-mono text-2xs text-muted"
                            v-tooltip.bottom.overflow="failure"
                        >
                            {{ failure }}
                        </li>
                        <li v-if="red.run.failureCount > FAILURES_SHOWN" class="text-2xs text-subtle">
                            {{ t(`agents.mainline.moreFailures`, { count: red.run.failureCount - FAILURES_SHOWN }, red.run.failureCount - FAILURES_SHOWN) }}
                        </li>
                    </ul>
                    <p v-else class="pr-2 pl-6 text-2xs text-subtle">{{ t(`agents.mainline.noFailureList`) }}</p>
                    <!-- Which work they came with, since the first thing a reader asks of a red is whose it is. -->
                    <div v-if="blamedLands(red.run).length > 0" class="pt-1.5 pr-2 pl-6 text-2xs text-subtle">{{ t(`agents.mainline.arrivedWith`) }}</div>
                    <div
                        v-for="land in blamedLands(red.run)"
                        :key="land.conversationId"
                        class="flex items-center gap-2 rounded-md py-0.5 pr-2 pl-6 hover:bg-overlay"
                    >
                        <span class="min-w-0 flex-1 truncate text-xs text-muted">{{ titleOf(land.conversationId, land.title) }}</span>
                        <button
                            type="button"
                            :class="ui.iconButton(`hover:bg-content/10`)"
                            :aria-label="t(`agents.mainline.openConversation`, { title: titleOf(land.conversationId, land.title) })"
                            @click="openNamed(land.conversationId, land.title)"
                        >
                            <Icon name="arrow-right" class="text-2xs" />
                        </button>
                    </div>
                    <div class="flex items-start gap-2 pt-1.5 pr-2 pl-6">
                        <Icon :name="routingMeta(red.routing?.kind).icon" class="mt-0.5 shrink-0 text-2xs text-muted" />
                        <span class="min-w-0 flex-1 text-2xs leading-relaxed text-muted">
                            <span class="text-content">{{ routingMeta(red.routing?.kind).words }}</span>
                            <template v-if="red.routing?.detail !== undefined">{{ SEP }}{{ red.routing.detail }}</template>
                        </span>
                        <button
                            v-if="red.routing?.conversationId !== undefined"
                            type="button"
                            :class="ui.linkButton(`shrink-0 gap-1 text-2xs`)"
                            :aria-label="t(`agents.mainline.openConversation`, { title: titleOf(red.routing.conversationId) })"
                            @click="openRouted(red.routing)"
                        >
                            {{ t(`agents.mainline.open`) }}<Icon name="arrow-right" class="text-2xs" />
                        </button>
                    </div>
                </section>

                <!-- Lands the next check will measure together. -->
                <section v-if="queued.length > 0" class="flex flex-col border-t border-line-subtle py-1">
                    <div class="flex items-center gap-2 px-2 py-1">
                        <Icon name="clock" class="shrink-0 text-2xs text-muted" />
                        <span class="min-w-0 flex-1 truncate text-xs text-content">{{ t(`agents.mainline.waitingNext`) }}</span>
                    </div>
                    <div
                        v-for="{ land, project } in queued"
                        :key="`${land.conversationId}-${land.at}`"
                        class="flex items-center gap-2 rounded-md py-0.5 pr-2 pl-6 hover:bg-overlay"
                    >
                        <span class="min-w-0 flex-1 truncate text-xs text-muted">{{ titleOf(land.conversationId, land.title) }}</span>
                        <span class="shrink-0 text-2xs text-subtle">{{ projectName(project) }}</span>
                        <button
                            type="button"
                            :class="ui.iconButton(`hover:bg-content/10`)"
                            :aria-label="t(`agents.mainline.openConversation`, { title: titleOf(land.conversationId, land.title) })"
                            @click="openNamed(land.conversationId, land.title)"
                        >
                            <Icon name="arrow-right" class="text-2xs" />
                        </button>
                    </div>
                </section>

                <!-- The record, newest first, across every project. -->
                <section v-if="recent.length > 0" class="flex flex-col border-t border-line-subtle py-1">
                    <div class="px-2 py-1 text-2xs font-medium uppercase tracking-wide text-muted">{{ t(`agents.mainline.recentChecks`) }}</div>
                    <div v-for="run in recent" :key="`${run.project}-${run.at}`" class="flex items-center gap-2 px-2 py-0.5 text-2xs">
                        <span class="h-1.5 w-1.5 shrink-0 rounded-full" :class="run.status === `green` ? `bg-success` : `bg-danger`"></span>
                        <span class="shrink-0 text-content">{{ projectName(run.project) }}</span>
                        <span class="min-w-0 flex-1 truncate text-subtle" v-tooltip.bottom.overflow="landsLine(run)">{{ landsLine(run) }}</span>
                        <span class="shrink-0" :class="run.status === `green` ? `text-success` : `text-danger`">{{
                            run.status === `green` ? t(`agents.mainline.passed`) : t(`agents.mainline.failed`)
                        }}</span>
                        <span class="shrink-0 tabular-nums text-subtle">{{ timeAgo(run.at, { now: minute, days: true }) }}</span>
                    </div>
                </section>

                <p class="border-t border-line-subtle px-2 pt-1.5 pb-1.5 text-2xs leading-relaxed text-subtle">{{ t(`agents.mainline.explain`) }}</p>
            </div>
        </AnchoredOverlay>
    </div>
</template>
