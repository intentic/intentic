<script setup lang="ts">
import {
    type AgentRunBooking,
    type AgentRunChoice,
    appLink,
    Button,
    Icon,
    messageOr,
    Notice,
    type NoticeModel,
    NoticeStack,
    RowGroup,
    SkeletonRows,
    SplitView,
    timeAgo,
    ui,
    useAsyncAction,
    useNow,
} from "@intentic/extension-ui";
import type { FixResume } from "@intentic/sandbox-contract/state/fix-attempt-plan";
import { computed, ref } from "vue";
import FindingRow from "./FindingRow.vue";
import { host } from "./host";
import { t } from "./i18n.js";
import { sectionsOf, titleOf } from "./sections";
import { fixRequestOf, useHealth } from "./useHealth";
import type { ConnectionState, Finding } from "./wire";

// What PostHog finds wrong in the product, in the order it owes a decision: what nobody is fixing, what an agent waits on
// the reader for, the owner's own steps, then what needs nobody (agents at work, decisions, setup advice, alerts that
// are quiet). Rows come from the backend's last round of reading PostHog; this page only presses.

const { snapshot, error, isPending, refresh, fix, resolve, dismiss, snooze, wire } = useHealth();
const api = host();
const now = useNow();
const { notice: pressNotice, run } = useAsyncAction();

// Changing what PostHog holds is the maintainer floor, as the backend holds it; below it the page reads and fixes.
const canWrite = computed(() => api.sandbox.tier() === `owner` || api.sandbox.tier() === `maintainer`);

const connections = computed<readonly ConnectionState[]>(() => snapshot.value?.connections ?? []);
const many = computed(() => connections.value.length > 1);
const sections = computed(() => sectionsOf(snapshot.value?.findings ?? [], now.value));
const showSnoozed = ref(false);
const visible = computed(() => sections.value.filter((section) => section.id !== `snoozed` || showSnoozed.value));
const snoozedCount = computed(() => sections.value.find((section) => section.id === `snoozed`)?.findings.length ?? 0);
const allClear = computed(() => sections.value.every((section) => section.id === `watch` || section.id === `snoozed`));

// One row open at a time, kept as an accordion rather than a stack of open evidence.
const opened = ref<string | undefined>(undefined);

// When PostHog was last read: the oldest connection's round, since that is how stale the page could be.
const readWords = computed(() => {
    const times = connections.value.map((connection) => connection.polledAt);
    if (times.length === 0) {
        return undefined;
    }
    const oldest = times.some((time) => time === undefined) ? undefined : Math.min(...times.filter((time) => time !== undefined));
    return oldest === undefined ? t(`view.neverRead`) : t(`view.readAt`, { when: timeAgo(oldest, { now: now.value }) });
});

const listNotice = computed<NoticeModel | undefined>(() => (error.value === undefined ? undefined : { tone: `danger`, title: t(`view.couldNotRead`), detail: error.value }));

// What a connection could not read on its last round, one line each: a source that failed leaves the rest standing.
const problems = computed(() =>
    connections.value.flatMap((connection) =>
        connection.problems.map((problem) => ({
            key: `${connection.id}:${problem.source}`,
            text: t(`view.problem`, {
                connection: connection.id,
                source: problem.source === `connection` ? t(`view.connectionSource`) : t(`source.${problem.source}`),
                message: problem.message,
            }),
        })),
    ),
);

const busy = ref<string | undefined>(undefined);

// The press opens the agents board at once (`chat.launchAgent`): a card stands in for the agent while the backend writes
// the brief and the sandbox starts the turn, and a refusal is said on that card.
const startFix = async (finding: Finding, pick: AgentRunChoice | undefined, resume: FixResume | undefined, booking: AgentRunBooking | undefined): Promise<void> => {
    busy.value = finding.id;
    try {
        const request = fixRequestOf(pick, api.models.agentRun(`product-health-fix`), resume, booking);
        const note = finding.lane === `decide` ? t(`row.deciding`) : t(`row.starting`);
        await api.chat.launchAgent({ title: titleOf(finding), note }, () => fix.mutateAsync({ finding, request }));
    } catch (failure) {
        pressNotice.value = { tone: `danger`, title: t(`view.pressFailed`), detail: messageOr(failure, ``) };
    } finally {
        busy.value = undefined;
    }
};

const pressOn = (finding: Finding, work: (finding: Finding) => Promise<{ readonly ok: true }>): void => {
    busy.value = finding.id;
    void run(async () => {
        try {
            await work(finding);
        } finally {
            busy.value = undefined;
        }
    }, t(`view.pressFailed`));
};

const wireHere = (connection: string): void => {
    busy.value = connection;
    void run(async () => {
        try {
            const { created } = await wire.mutateAsync(connection);
            pressNotice.value = { tone: `success`, title: t(`row.wired`, { count: created }, created) };
        } finally {
            busy.value = undefined;
        }
    }, t(`view.pressFailed`));
};

const postHogPage = api.links.capabilities(`posthog`);
const connectLink = computed(() => appLink(api.href(postHogPage), () => api.navigate(postHogPage)));
</script>

<template>
    <SplitView :title="t(`title`)" scroll="page">
        <template #actions>
            <span v-if="readWords" class="text-xs text-muted tabular-nums">{{ readWords }}</span>
            <Button v-if="connections.length > 0" :label="t(`view.refresh`)" size="small" tier="quiet" :loading="refresh.isPending.value" @click="refresh.mutate()">
                <template #icon><Icon name="refresh" class="text-2xs" /></template>
            </Button>
        </template>

        <template #strips>
            <NoticeStack :of="[pressNotice, listNotice]" />
            <Notice v-for="problem in problems" :key="problem.key" tone="warning">{{ problem.text }}</Notice>
        </template>

        <template #detail>
            <RowGroup v-if="isPending" role="status" aria-busy="true">
                <span class="sr-only">{{ t(`view.reading`) }}</span>
                <SkeletonRows :rows="3" description control />
            </RowGroup>

            <div v-else-if="connections.length === 0" :class="ui.emptyState(`flex flex-col items-center gap-3 py-8`)">
                <p>{{ t(`view.noConnection`) }}</p>
                <Button as="a" v-bind="connectLink" size="small" tier="accent">{{ t(`view.connect`) }}</Button>
            </div>

            <div v-else class="flex flex-col gap-4">
                <p v-if="allClear" :class="ui.emptyState(`py-6`)">{{ t(`view.allClear`) }}</p>
                <RowGroup v-for="section in visible" :key="section.id" :label="t(`section.${section.id}`)">
                    <FindingRow
                        v-for="finding in section.findings"
                        :key="finding.id"
                        :finding="finding"
                        :section="section.id"
                        :now="now"
                        :many="many"
                        :can-write="canWrite"
                        :busy="busy"
                        :open="opened === finding.id"
                        @update:open="(open: boolean) => (opened = open ? finding.id : undefined)"
                        @fix="startFix"
                        @resolve="(target: Finding) => pressOn(target, (each) => resolve.mutateAsync(each))"
                        @snooze="(target: Finding) => pressOn(target, (each) => snooze.mutateAsync(each))"
                        @dismiss="(target: Finding) => pressOn(target, (each) => dismiss.mutateAsync(each))"
                        @wire="wireHere"
                    />
                </RowGroup>
                <Button
                    v-if="snoozedCount > 0"
                    class="self-start"
                    :label="showSnoozed ? t(`view.hideSnoozed`) : t(`view.showSnoozed`, { count: snoozedCount })"
                    size="small"
                    tier="quiet"
                    @click="showSnoozed = !showSnoozed"
                />
            </div>
        </template>
    </SplitView>
</template>
