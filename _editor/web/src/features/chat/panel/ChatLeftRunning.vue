<script setup lang="ts">
import type { AgentJob, AgentWatch } from "@intentic/sandbox-contract";
import { briefDuration } from "@intentic/base/format";
import type { IconName } from "@intentic/ui";
import { errorMessage, useNow } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { formatElapsed } from "../../agents/fleet/agentStatus";
import { useAgents } from "../../agents/fleet/useAgents";
import { portTargetId } from "../../preview/previewModel";
import { openPreview } from "../../preview/previewSurface";
import { useSandbox } from "../../sandbox/client/useSandbox";
import { useChatSurface } from "../tools/chatToolSurface";
import { portsLine, runningJobs } from "../transcript/jobPhase";
import { usePaneView } from "./useChat-view";

// What a chat whose turn is over still has going, at the foot of the transcript where a reader looks to see whether it
// is done: the jobs the turn left (the ones it waits on, which wake it when they exit, and the servers it left running
// for the person) and the watches it armed. The transcript rows that started them scroll away; the status bar's count
// says how many, not that the chat is not finished. Absent while a turn streams, whose own status line speaks for it.

const t = useT();

const { conversation, streaming } = usePaneView();
const { agentById, stopJob, stopWatching } = useAgents();
const { reachable } = useSandbox();
const surface = useChatSurface();
const router = useRouter();

const agent = computed(() => agentById(conversation.value.conversationId));
const jobs = computed(() => runningJobs(agent.value?.jobs));
// A job's own watch is said on the job's row; only the watches the agent armed itself get rows of their own.
const jobWatches = computed(() => new Set(jobs.value.flatMap((job) => (job.watch === undefined ? [] : [job.watch]))));
const watches = computed(() => (agent.value?.watches ?? []).filter((watch) => !jobWatches.value.has(watch.id)));

const visible = computed(() => !streaming.value && (jobs.value.length > 0 || watches.value.length > 0));
const now = useNow(() => visible.value);

// Whether anything here runs the chat again by itself, which is what "is it done?" is really asking.
const wakes = computed(() => watches.value.length > 0 || jobs.value.some((job) => job.handed !== true));

interface Row {
    readonly key: string;
    readonly icon: IconName;
    readonly spin: boolean;
    readonly label: string;
    readonly detail: string;
    readonly job?: AgentJob;
    readonly watch?: AgentWatch;
}

const watchOf = (job: AgentJob): AgentWatch | undefined => agent.value?.watches?.find((watch) => watch.id === job.watch);

const jobDetail = (job: AgentJob): string => {
    const elapsed = formatElapsed(job.startedAt, now.value);
    if (job.stoppedBy !== undefined) {
        return t(`chat.chatLeftRunning.stopping`);
    }
    if (job.handed === true) {
        return t(`chat.chatLeftRunning.servedOn`, { ports: portsLine(job.ports ?? []), elapsed });
    }
    const watch = watchOf(job);
    return watch === undefined
        ? t(`chat.chatLeftRunning.running`, { elapsed })
        : t(`chat.chatLeftRunning.wakesOnExit`, { elapsed, left: formatElapsed(now.value, watch.deadlineAt) });
};

const rows = computed((): readonly Row[] => [
    ...jobs.value.map((job) => ({
        key: `job:${job.id}`,
        icon: (job.stoppedBy !== undefined ? `stop` : job.handed === true ? `server` : `spinner`) as IconName,
        spin: job.stoppedBy === undefined && job.handed !== true,
        label: job.label,
        detail: jobDetail(job),
        job,
    })),
    ...watches.value.map((watch) => ({
        key: `watch:${watch.id}`,
        icon: `eye` as IconName,
        spin: false,
        label: watch.note,
        detail: t(`chat.chatLeftRunning.watchLine`, { interval: briefDuration(watch.intervalSeconds), left: formatElapsed(now.value, watch.deadlineAt) }),
        watch,
    })),
]);

// One press at a time per row; a refusal is said under the card, since the row it came from may be gone by then.
const pressing = ref<string>();
const refused = ref<string>();
const press = async (key: string, act: () => Promise<void>): Promise<void> => {
    pressing.value = key;
    refused.value = undefined;
    try {
        await act();
    } catch (error) {
        refused.value = errorMessage(error, t(`chat.chatLeftRunning.stopFailed`));
    } finally {
        pressing.value = undefined;
    }
};

const id = (): string => conversation.value.conversationId;
const stop = (row: Row): void => {
    if (row.job !== undefined) {
        const jobId = row.job.id;
        void press(row.key, () => stopJob(id(), jobId));
    } else if (row.watch !== undefined) {
        const watchId = row.watch.id;
        void press(row.key, () => stopWatching(id(), watchId));
    }
};

// A server left for the person opens where a person looks at one; Preview offers publishing it from there.
const preview = (job: AgentJob): void => {
    const port = job.ports?.[0];
    if (port !== undefined) {
        openPreview(router, portTargetId(port));
    }
};
</script>

<template>
    <div v-if="visible" class="chat-left-running flex flex-col gap-1.5 rounded-xl border border-line-strong bg-card px-3 py-2 text-2xs text-muted" role="status">
        <div class="flex items-start gap-2">
            <Icon :name="wakes ? `clock` : `server`" class="mt-0.5 shrink-0" />
            <div class="flex min-w-0 flex-col">
                <span class="font-medium text-content">{{ t(`chat.chatLeftRunning.title`) }}</span>
                <span class="text-subtle">{{ wakes ? t(`chat.chatLeftRunning.wakes`) : t(`chat.chatLeftRunning.leftForYou`) }}</span>
            </div>
        </div>
        <!-- Name above what happens next, so a narrow pane cuts neither: the deadline and the port are the point of the row. -->
        <div v-for="row in rows" :key="row.key" class="flex min-w-0 items-center gap-2 border-t border-line pt-1.5">
            <Icon :name="row.icon" :spin="row.spin" class="shrink-0 text-2xs" :class="row.icon === `spinner` ? `text-link` : `text-subtle`" />
            <div class="flex min-w-0 flex-1 flex-col">
                <span class="truncate text-content" :title="row.label">{{ row.label }}</span>
                <span class="text-subtle">{{ row.detail }}</span>
            </div>
            <div class="flex shrink-0 items-center gap-0.5">
                <button
                    v-if="row.job?.handed === true && row.job.ports !== undefined && row.job.stoppedBy === undefined"
                    type="button"
                    class="rounded px-1.5 py-0.5 transition-colors hover:bg-overlay hover:text-content"
                    @click="preview(row.job)"
                >
                    {{ t(`chat.chatLeftRunning.openInPreview`) }}
                </button>
                <button
                    v-if="row.job !== undefined && surface.watchTerminal !== undefined"
                    type="button"
                    class="flex items-center rounded p-1 transition-colors hover:bg-overlay hover:text-content"
                    v-tooltip.top="t(`shared.watchInTerminal`)"
                    :aria-label="t(`shared.watchInTerminal`)"
                    @click="surface.watchTerminal(row.job.session)"
                >
                    <Icon name="desktop" class="text-2xs" />
                </button>
                <button
                    v-if="row.job?.stoppedBy === undefined"
                    type="button"
                    class="rounded px-1.5 py-0.5 transition-colors hover:bg-overlay hover:text-content disabled:opacity-50"
                    :disabled="!reachable || pressing === row.key"
                    v-tooltip.top="row.watch !== undefined ? t(`chat.chatLeftRunning.stopWatchingHint`) : t(`chat.chatLeftRunning.stopHint`)"
                    @click="stop(row)"
                >
                    {{ row.watch !== undefined ? t(`shared.stopWatching`) : t(`ui.action.stop`) }}
                </button>
            </div>
        </div>
        <span v-if="refused !== undefined" role="alert" class="text-danger">{{ refused }}</span>
    </div>
</template>
