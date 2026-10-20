<script setup lang="ts">
import type { AgentJob, AgentWatch } from "@intentic/sandbox-contract/schemas/agents";
import { formatElapsed, type IconName, ui } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { useRouter } from "vue-router";
import { useAgents } from "../../../../models/fleet/useAgents";
import { portTargetId } from "../../../../models/preview/previewModel";
import { openPreviewBeside } from "../../../../workbench/browsers/browsersSurface";
import { useOperations } from "../../../../workbench/operations/operations";
import { useSandbox } from "../../../../client/sandbox/useSandbox";
import { useChatSurface } from "../../../../models/conversations/tools/chatToolSurface";
import { portsLine, runningJobs } from "../../transcript/jobPhase";
import { usePaneView } from "../../../../models/conversations/panel/useChat-view";

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

// A job sitting at a prompt (AgentJob.inputWait): its exit, the one thing its wake waits on, will not come by itself.
const asking = (job: AgentJob): boolean => job.inputWait !== undefined && job.stoppedBy === undefined;
const atPrompt = computed(() => jobs.value.some(asking));

// Whether anything here runs the chat again by itself, which is what "is it done?" is really asking.
const wakes = computed(() => watches.value.length > 0 || jobs.value.some((job) => job.handed !== true && !asking(job)));

interface Row {
    readonly key: string;
    readonly icon: IconName;
    readonly spin: boolean;
    readonly label: string;
    readonly detail: string;
    // Said in the warning hue: a command at a prompt, which only a press or a person typing ends.
    readonly warn: boolean;
    readonly job?: AgentJob;
    readonly watch?: AgentWatch;
}

const watchOf = (job: AgentJob): AgentWatch | undefined => agent.value?.watches?.find((watch) => watch.id === job.watch);

const jobDetail = (job: AgentJob): string => {
    const elapsed = formatElapsed((now.value - job.startedAt) / 1000);
    if (job.stoppedBy !== undefined) {
        return t(`chat.chatLeftRunning.stopping`);
    }
    if (job.inputWait !== undefined) {
        return t(`chat.chatLeftRunning.atPrompt`, { elapsed: formatElapsed((now.value - job.inputWait.since) / 1000), program: job.inputWait.program });
    }
    if (job.handed === true) {
        return t(`chat.chatLeftRunning.servedOn`, { ports: portsLine(job.ports ?? []), elapsed });
    }
    const watch = watchOf(job);
    return watch === undefined
        ? t(`chat.chatLeftRunning.running`, { elapsed })
        : t(`chat.chatLeftRunning.wakesOnExit`, { elapsed, left: formatElapsed((watch.deadlineAt - now.value) / 1000) });
};

const rows = computed((): readonly Row[] => [
    ...jobs.value.map((job) => ({
        key: `job:${job.id}`,
        icon: (job.stoppedBy !== undefined ? `stop` : asking(job) ? `terminal` : job.handed === true ? `server` : `spinner`) as IconName,
        spin: job.stoppedBy === undefined && job.handed !== true && !asking(job),
        label: job.label,
        detail: jobDetail(job),
        warn: asking(job),
        job,
    })),
    ...watches.value.map((watch) => ({
        key: `watch:${watch.id}`,
        icon: `eye` as IconName,
        spin: false,
        label: watch.note,
        detail: t(`chat.chatLeftRunning.watchLine`, { interval: formatElapsed(watch.intervalSeconds), left: formatElapsed((watch.deadlineAt - now.value) / 1000) }),
        warn: false,
        watch,
    })),
]);

// One press at a time per row, kept with the conversation rather than this card, which goes whenever a turn starts or
// the pane closes: a stop still out is still held when the card is drawn again, and a refusal (which leaves the thing
// running) is still said. Said under the card, since the row it came from may be gone by then; only the latest press
// speaks there, as a fresh press used to clear the last one's refusal. A watch's row in the transcript (NoticeWatchStop)
// files its stop under the same key, so the two surfaces hold one press between them.
const stops = useOperations(() => `chat/${conversation.value.conversationId}/stops`);
const pressing = (key: string): boolean => stops.at(key)?.state === `running`;
const refused = computed(() => {
    const last = stops.all.value.toSorted((a, b) => b.order - a.order)[0];
    return last?.state === `failed` && last.failure !== undefined ? (last.failure.detail ?? last.failure.title) : undefined;
});
const press = (row: Row, act: () => Promise<void>): void => {
    void stops.run(row.key, {
        what: t(`chat.chatLeftRunning.stoppingRow`, { label: row.label }),
        failed: t(`chat.chatLeftRunning.stopFailed`),
        done: () => t(`chat.chatLeftRunning.stoppedRow`, { label: row.label }),
        task: act,
    });
};

const stop = (row: Row): void => {
    const id = conversation.value.conversationId;
    if (row.job !== undefined) {
        const jobId = row.job.id;
        press(row, () => stopJob(id, jobId));
    } else if (row.watch !== undefined) {
        const watchId = row.watch.id;
        press(row, () => stopWatching(id, watchId));
    }
};

// A server left for the person opens where a person looks at one, beside the chat that started it, so what it serves
// and the conversation changing it are on one screen; Preview offers publishing it from there.
const preview = (job: AgentJob): void => {
    const port = job.ports?.[0];
    if (port !== undefined) {
        openPreviewBeside(router, portTargetId(port));
    }
};
</script>

<template>
    <div v-if="visible" class="chat-left-running flex flex-col gap-1.5 rounded-xl bg-card shadow-sm px-3 py-2 text-2xs text-muted" role="status">
        <div class="flex items-start gap-2">
            <Icon :name="wakes ? `clock` : `server`" class="shrink-0" />
            <div class="flex min-w-0 flex-col">
                <span class="font-medium text-content">{{ t(`chat.chatLeftRunning.title`) }}</span>
                <span class="text-subtle">{{
                    atPrompt ? t(`chat.chatLeftRunning.stuckAtPrompt`) : wakes ? t(`chat.chatLeftRunning.wakes`) : t(`chat.chatLeftRunning.leftForYou`)
                }}</span>
            </div>
        </div>
        <!-- Name above what happens next, so a narrow pane cuts neither: the deadline and the port are the point of the row. -->
        <div v-for="row in rows" :key="row.key" class="flex min-w-0 items-center gap-2 border-t border-line pt-1.5">
            <Icon :name="row.icon" :spin="row.spin" class="shrink-0 text-2xs" :class="row.warn ? `text-warning` : row.icon === `spinner` ? `text-link` : `text-subtle`" />
            <div class="flex min-w-0 flex-1 flex-col">
                <span class="truncate text-content" v-tooltip.top.overflow="row.label">{{ row.label }}</span>
                <span :class="row.warn ? `text-warning` : `text-subtle`">{{ row.detail }}</span>
            </div>
            <div class="flex shrink-0 items-center gap-0.5">
                <button
                    v-if="row.job?.handed === true && row.job.ports !== undefined && row.job.stoppedBy === undefined"
                    type="button"
                    :class="ui.textButton({ tone: `quiet`, size: `xs` })"
                    @click="preview(row.job)"
                >
                    {{ t(`chat.chatLeftRunning.openInPreview`) }}
                </button>
                <button
                    v-if="row.job !== undefined && surface.watchTerminal !== undefined"
                    type="button"
                    class="touch-target flex items-center rounded p-1 transition-colors hover:bg-overlay hover:text-content"
                    v-tooltip.top="t(`chat.words.showTerminal`)"
                    :aria-label="t(`chat.words.watchInTerminal`)"
                    @click="surface.watchTerminal(row.job.session)"
                >
                    <Icon name="desktop" class="text-2xs" />
                </button>
                <button
                    v-if="row.job?.stoppedBy === undefined"
                    type="button"
                    :class="ui.textButton({ tone: `quiet`, size: `xs` })"
                    :disabled="!reachable || pressing(row.key)"
                    v-tooltip.top="{
                        title: row.watch !== undefined ? t(`chat.chatLeftRunning.disarm`) : t(`chat.chatLeftRunning.endNow`),
                        note: t(`chat.chatLeftRunning.chatWontWake`),
                    }"
                    @click="stop(row)"
                >
                    {{ row.watch !== undefined ? t(`agents.words.stopWatching`) : t(`ui.action.stop`) }}
                </button>
            </div>
        </div>
        <span v-if="refused !== undefined" role="alert" class="text-danger">{{ refused }}</span>
    </div>
</template>
