<script setup lang="ts">
import { Button, Code, DeviceRunLog, Icon } from "@intentic/ui";
import { computed, ref } from "vue";
import { type AgentRun, agentRunDetail, agentRunTitle } from "../runners/agentRun";
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

// Spelled out per state, not templated: Tailwind only emits a utility it can see used literally.
const SURFACE: Record<AgentRun[`state`], string> = {
    running: `border-line-subtle bg-content/5`,
    waiting: `border-line-subtle bg-content/5`,
    done: `border-success/40 bg-success/10`,
    failed: `border-danger/40 bg-danger/10`,
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
            </div>
            <div class="ml-auto flex shrink-0 items-center gap-0.5">
                <Button
                    v-if="run.lines.length > 0"
                    size="small"
                    severity="secondary"
                    :text="true"
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
                    severity="secondary"
                    :text="true"
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
        <Code
            v-if="run.state === `failed` && run.failure?.command"
            :code="run.failure.command"
            lang="bash"
            :label="t(`sandbox.deviceOpFailure.runOnYourself`, { machine })"
            wrap
        />
    </div>
</template>
