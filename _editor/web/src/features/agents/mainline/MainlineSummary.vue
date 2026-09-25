<script setup lang="ts">
import { useNow } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { formatElapsed } from "../fleet/agentStatus";
import { fixTone, type MainlineSummary, projectName, routingMeta } from "./mainlineView";

// THE MAIN LINE AT REST, inside its status-bar segment: two short answers side by side and nothing else. Health first
// (the red project and who has it, how many are red, or that main passes), then activity (the check running and for
// how long, and how many lands queue behind it). What a check runs, whose work it measures and why a red waits are the
// panel's to say; the bar is read at a glance, so it never carries a sentence. Last, in amber, how many findings pushes
// left behind: a count, since none of it is urgent and it waits for the owner whenever they get to it.

const t = useT();

const props = defineProps<{
    summary: MainlineSummary;
}>();

const running = computed(() => props.summary.running);
const worst = computed(() => props.summary.reds[0]);
const redCount = computed(() => props.summary.reds.length);
// Who has it, in one or two words, only when there is one red to say it about.
const fix = computed(() => (redCount.value === 1 ? routingMeta(worst.value?.routing?.kind) : undefined));

// A running check's elapsed moves every second; nothing else on the bar moves with the clock.
const now = useNow(() => running.value !== undefined);
</script>

<template>
    <span class="flex min-w-0 items-center gap-3">
        <span v-if="worst !== undefined" data-item="health" class="flex min-w-0 items-center gap-1.5">
            <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-danger"></span>
            <span class="min-w-0 truncate font-medium text-danger">{{
                redCount === 1
                    ? t(`agents.mainline.projectFailing`, { project: projectName(worst.project) })
                    : t(`agents.mainline.projectsFailing`, { count: redCount }, redCount)
            }}</span>
            <span v-if="fix?.short !== undefined" class="shrink-0" :class="fixTone(fix.state)">· {{ fix.short }}</span>
        </span>
        <span v-else-if="summary.checked" data-item="health" class="flex shrink-0 items-center gap-1.5">
            <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-success"></span>
            <span class="text-content">{{ t(`agents.mainline.mainPassing`) }}</span>
        </span>
        <span v-if="running !== undefined" data-item="running" class="flex min-w-0 items-center gap-1.5 text-muted">
            <Icon name="spinner" spin class="shrink-0 text-2xs text-link" />
            <span class="min-w-0 truncate">{{
                running.on === undefined
                    ? t(`agents.mainline.checking`, { project: projectName(running.project) })
                    : t(`agents.mainline.checkingOn`, { project: projectName(running.project), machine: running.on })
            }}</span>
            <span class="shrink-0 tabular-nums">{{ formatElapsed(running.startedAt, now) }}</span>
        </span>
        <span v-if="summary.queued > 0" data-item="queued" class="shrink-0 text-muted">{{
            t(`agents.mainline.queued`, { count: summary.queued })
        }}</span>
        <span v-if="summary.leftAtPush > 0" data-item="push" class="flex shrink-0 items-center gap-1.5 text-warning">
            <Icon name="arrow-up-right" class="shrink-0 text-2xs" />
            <span>{{ t(`agents.mainline.push.bar`, { count: summary.leftAtPush }, summary.leftAtPush) }}</span>
        </span>
    </span>
</template>
