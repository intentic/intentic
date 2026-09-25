<script setup lang="ts">
import { useNow } from "@intentic/ui/async";
import { timeAgo } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { formatElapsed } from "../fleet/agentStatus";
import { useLandTitle } from "./openLanded";
import { type MainlineSummary, projectName, sinceWhen } from "./mainlineView";

// THE MAIN LINE AT REST, inside its status-bar segment: everything a reader watches it for, with nothing to open. The
// check running now by name (the project, the command, how long, and whose work it measures), every red and since
// when, how many lands wait, and only when none of those has anything to say, when main was last seen green.

const t = useT();

const props = defineProps<{
    summary: MainlineSummary;
}>();

const landTitle = useLandTitle();

const running = computed(() => props.summary.running);
const worst = computed(() => props.summary.reds[0]);
const otherReds = computed(() => props.summary.reds.length - 1);
// Something else on the line already says main has news, so the queue can be a count rather than a sentence.
const crowded = computed(() => running.value !== undefined || worst.value !== undefined);

// A running check's elapsed moves every second; "checked 5m ago" reads its minute, so it redraws once a minute rather
// than with every tick. A red names the wall-clock minute it began, which never needs one.
const now = useNow(() => running.value !== undefined || props.summary.greenAt !== undefined);
const minute = computed(() => Math.floor(now.value / 60_000) * 60_000);

// Whose work the running check measures: the first land by name, the rest counted; a run no land asked for says so.
const measuring = computed<string>(() => {
    const lands = running.value?.lands ?? [];
    const [first] = lands;
    if (first === undefined) {
        return t(`agents.mainline.recheck`);
    }
    const title = landTitle(first.conversationId, first.title);
    return lands.length === 1 ? title : t(`agents.mainline.andMore`, { title, count: lands.length - 1 }, lands.length - 1);
});
const measuringAll = computed(() => (running.value?.lands ?? []).map((land) => landTitle(land.conversationId, land.title)).join(`\n`));
</script>

<template>
    <span class="flex min-w-0 items-center gap-3">
        <span v-if="running !== undefined" data-item="running" class="flex min-w-0 items-center gap-1.5">
            <Icon name="spinner" spin class="shrink-0 text-2xs text-link" />
            <span class="shrink-0 font-medium text-content">{{ t(`agents.mainline.checkingMain`) }}</span>
            <span class="shrink-0 text-content">{{ projectName(running.project) }}</span>
            <span class="shrink-0 tabular-nums text-muted">{{ formatElapsed(running.startedAt, now) }}</span>
            <code class="max-w-48 shrink-0 truncate font-mono text-subtle">{{ running.command }}</code>
            <span class="min-w-0 truncate text-muted" v-tooltip.top.overflow="measuringAll">
                <Icon name="arrow-right" class="mr-1 text-2xs text-subtle" />{{ measuring }}
            </span>
        </span>
        <span v-if="worst !== undefined" data-item="red" class="flex shrink-0 items-center gap-1.5 text-danger">
            <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-danger"></span>
            <template v-if="running === undefined">
                <span class="font-medium">{{ t(`agents.mainline.redSince`, { project: projectName(worst.project), time: sinceWhen(worst.since, minute) }) }}</span>
                <span v-if="worst.run.failureCount > 0">{{ t(`agents.mainline.failures`, { count: worst.run.failureCount }, worst.run.failureCount) }}</span>
            </template>
            <span v-else class="font-medium">{{ t(`agents.mainline.alsoRed`, { project: projectName(worst.project) }) }}</span>
            <span v-if="otherReds > 0">{{ t(`agents.mainline.moreRed`, { count: otherReds }, otherReds) }}</span>
        </span>
        <span v-if="summary.waiting > 0" data-item="waiting" class="flex shrink-0 items-center gap-1.5 text-muted">
            <Icon name="clock" class="shrink-0 text-2xs" />
            <span>{{
                crowded
                    ? t(`agents.mainline.waitingShort`, { count: summary.waiting }, summary.waiting)
                    : t(`agents.mainline.landsWaiting`, { count: summary.waiting }, summary.waiting)
            }}</span>
        </span>
        <span v-if="summary.greenAt !== undefined" data-item="green" class="flex shrink-0 items-center gap-1.5">
            <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-success"></span>
            <span class="text-content">{{ t(`agents.mainline.mainGreen`) }}</span>
            <span class="text-muted">{{ t(`agents.mainline.checkedAgo`, { ago: timeAgo(summary.greenAt, { now: minute, days: true }) }) }}</span>
        </span>
    </span>
</template>
