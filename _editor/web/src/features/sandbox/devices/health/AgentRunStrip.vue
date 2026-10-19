<script setup lang="ts">
import { Button, DeviceRunLog, Icon, toneTint } from "@intentic/ui";
import RunCommand from "../../../../components/RunCommand.vue";
import WaitProgress from "../../../../components/WaitProgress.vue";
import { useWaitClock } from "../../../../components/useWaitClock";
import { spanWords } from "../../../../components/waitProgress";
import { computed, ref } from "vue";
import { type AgentRun, agentRunDetail, agentRunTitle } from "../runners/agentRun";
import { AGENT_RETURN_DEADLINE_MS } from "../runners/deviceWork";
import { useT } from "@intentic/ui/i18n";

// One press of an agent verb, drawn where the concern that offered it stood, so the question and its answer occupy
// the same line: the strip that said "5 links stopped answering · Forget them" becomes "Forgetting 5…", then
// "Forgot 5 unreachable links", in the same place and the same shape. Tinted by outcome, like <DeviceConcern> — the
// edge and the glyph carry the colour, never the sentence. The machine's own output is one press away rather than
// the whole answer: it is evidence, and a pane of log lines was what made a finished drop look unfinished.

const t = useT();

const { run, machine } = defineProps<{
    run: AgentRun;
    /** The machine's name, for the line a refusal offers to type there. */
    machine: string;
}>();

const emit = defineEmits<{ dismiss: [] }>();

const busy = computed(() => run.state === `running` || run.state === `waiting`);
const title = computed(() => agentRunTitle(run));
const detail = computed(() => agentRunDetail(run) ?? (run.state === `failed` ? run.failure?.notice.detail : undefined));
// While it works, the newest line the machine printed stands in for the log: proof of motion without the pane.
const latest = computed(() => (run.state === `running` ? run.lines.at(-1) : undefined));
const showing = ref(false);

// How long it has been going, and how long it is given. An update downloads and installs before the agent comes back on
// the new build, so a strip saying only "Waiting for its agent to come back…" read the same at second ten as at minute
// four. Past the deadline (deviceWork.ts) the run stops counting as work in flight and the machine's own status says
// what is wrong, which is what the strip promises. A drop of links has no agent to wait for and no deadline.
const wait = useWaitClock(() => (busy.value ? run.startedAt : undefined));
const deadline = computed(() =>
    busy.value && run.op !== `forget-unreachable` && (wait.value?.elapsedMs ?? 0) < AGENT_RETURN_DEADLINE_MS
        ? t(`sandbox.agentRun.deadline`, { limit: spanWords(AGENT_RETURN_DEADLINE_MS) })
        : undefined,
);

// The two outcomes wear the kit's strong tint (tone.ts), as <DeviceConcern> does; a run still going sits on the
// page's own surface.
const SURFACE: Record<AgentRun[`state`], string> = {
    running: `border-line-subtle bg-content/5`,
    waiting: `border-line-subtle bg-content/5`,
    done: toneTint(`success`),
    failed: toneTint(`danger`),
};
const GLYPH: Record<AgentRun[`state`], string> = { running: `text-muted`, waiting: `text-muted`, done: `text-success`, failed: `text-danger` };
const ICON = { running: `spinner`, waiting: `spinner`, done: `check-circle`, failed: `exclamation-triangle` } as const;
</script>

<template>
    <!-- `status` while it works and once it has, `alert` when it was refused: the one state a reader must act on. -->
    <div class="flex flex-col gap-2 rounded-lg border px-3 py-2.5" :class="SURFACE[run.state]" :role="run.state === `failed` ? `alert` : `status`">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <Icon :name="ICON[run.state]" :spin="busy" class="shrink-0 text-sm" :class="GLYPH[run.state]" aria-hidden="true" />
            <div class="flex min-w-0 grow basis-64 flex-col gap-0.5">
                <p class="text-xs font-medium text-content">{{ title }}</p>
                <p v-if="detail" class="text-2xs text-muted">{{ detail }}</p>
                <p v-else-if="latest" class="truncate font-mono text-2xs text-subtle">{{ latest }}</p>
                <WaitProgress v-if="wait" :wait="wait" class="mt-0.5" />
                <p v-if="deadline" class="text-2xs text-subtle">{{ deadline }}</p>
            </div>
            <div class="ml-auto flex shrink-0 items-center gap-0.5">
                <Button
                    v-if="run.lines.length > 0"
                    size="small"
                    tier="quiet"
                    :label="showing ? t(`sandbox.agentRun.hideOutput`) : t(`sandbox.agentRun.showOutput`)"
                    :aria-expanded="showing"
                    @click="showing = !showing"
                >
                    <template #icon><Icon name="terminal" /></template>
                </Button>
                <!-- Nothing to put away while it runs: the strip is the only thing saying the machine is busy. -->
                <Button
                    v-if="!busy"
                    size="small"
                    tier="quiet"
                    :aria-label="t(`ui.action.dismiss`)"
                    v-tooltip.top="t(`ui.action.dismiss`)"
                    @click="emit(`dismiss`)"
                >
                    <template #icon><Icon name="times" /></template>
                </Button>
            </div>
        </div>
        <DeviceRunLog
            v-if="showing"
            :lines="run.lines"
            :running="busy"
            :empty="t(`sandbox.devicePage.startingOnDevice`)"
            :note="t(`sandbox.devicePage.runsOnDeviceKeeps`)"
        />
        <!-- The same act as a line to type out there: the usual reason a press is refused is a route this browser can't open. -->
        <RunCommand
            v-if="run.state === `failed` && run.failure?.command"
            :command="run.failure.command"
            :label="t(`sandbox.deviceOpFailure.runOnYourself`, { machine })"
        />
    </div>
</template>
