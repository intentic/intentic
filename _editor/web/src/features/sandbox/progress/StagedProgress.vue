<script setup lang="ts">
import { DeviceRunLog, formatElapsed, type IconName, ui } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { computed } from "vue";
import { type ProgressStatus, type ProgressStep, type StepState, stepFill, stepSeconds, stepState } from "./stagedProgress";
import { useT } from "@intentic/ui/i18n";

// A LONG RUN DRAWN AS THE FEW THINGS IT DOES, not as a wall of somebody else's output. The log is what a reader
// reaches for when something has gone wrong, and the rest of the time it is noise that hides the one fact they came
// for — so it sits behind a toggle the caller opens on a failure. One moving part on screen: the bar and the step list
// share a single spinner, on whichever step is running. What is particular to one kind of run (its cost to the reader,
// its verdict, where its ending is written) goes in the default slot, between the steps and the log.

const t = useT();

const props = defineProps<{
    /** One line for the whole run: what it is. */
    heading: string;
    /** Seconds this run has been going; undefined for one adopted mid-flight, whose start nothing here saw. */
    elapsed: number | undefined;
    steps: readonly ProgressStep[];
    /** The step the run is on, or the last it reached once it has ended. */
    stage: string;
    /** When each step was first seen, so the card can time a step it watched begin. */
    stageAt: Partial<Record<string, number>>;
    endedAt: number | undefined;
    /** How far along, 0–1, never decreasing. */
    fraction: number;
    status: ProgressStatus;
    /** Still going on the machine, as far as this page knows: a step gone unheard-from may be either. */
    live: boolean;
    /** What the running step is on this second, in the tool's own words; the step's own note when absent. */
    detail: string | undefined;
    lines: readonly string[];
    /** What the log pane says before its first line. */
    emptyLog: string;
    showLogLabel: string;
    hideLogLabel: string;
    /** Under the log while it still fills: where the run lives, so closing the page is not mistaken for stopping it. */
    logNote?: string | undefined;
}>();

defineEmits<{ dismiss: [] }>();

// Opened by the reader, or by the caller on a failure, where the lines ARE the answer.
const showLog = defineModel<boolean>(`log`, { default: false });

const now = useNow(() => props.live);

const steps = computed(() => {
    const end = props.endedAt ?? (props.live ? now.value : undefined);
    return props.steps.map((step) => ({
        ...step,
        state: stepState(props.steps, step.key, props.stage, props.status),
        seconds: stepSeconds(props.steps, step.key, props.stageAt, end),
        fill: stepFill(props.steps, step.key, props.fraction),
    }));
});

const ICONS: Record<StepState, IconName> = {
    done: `check-circle`,
    running: `spinner`,
    pending: `circle`,
    stopped: `exclamation-triangle`,
    unheard: `question-circle`,
};
const TONES: Record<StepState, string> = {
    done: `text-success`,
    running: `text-info`,
    pending: `text-muted`,
    stopped: `text-warning`,
    unheard: `text-warning`,
};

const elapsedLabel = computed(() => (props.elapsed === undefined ? undefined : formatElapsed(props.elapsed)));
</script>

<template>
    <!-- No card of its own: it is drawn inside a group that is already a surface, and a second border there is chrome. -->
    <div class="flex flex-col gap-3">
        <!-- One line for the whole run: what it is, and how long it has been going. -->
        <div class="flex items-baseline gap-2">
            <span class="flex-1 text-xs font-medium text-content">{{ heading }}</span>
            <span v-if="elapsedLabel" class="shrink-0 font-mono text-2xs tabular-nums text-muted">{{ elapsedLabel }}</span>
        </div>

        <!-- One segment per step, sized by how long that step takes, so a full segment means a finished step rather
             than a share of an arbitrary total. A running step with nothing countable in it pulses instead of
             claiming a number. -->
        <div class="flex h-1.5 gap-0.5 overflow-hidden rounded-full">
            <div
                v-for="step in steps"
                :key="step.key"
                class="h-full overflow-hidden rounded-full"
                :class="step.state === 'running' && step.fill === 0 ? `animate-pulse bg-primary-400/30` : `bg-canvas`"
                :style="{ flexGrow: step.weight, flexBasis: 0 }"
            >
                <div
                    class="h-full rounded-full transition-[width] duration-500 ease-out"
                    :class="step.state === 'stopped' ? `bg-warning` : `bg-primary-400`"
                    :style="{ width: `${step.state === 'done' ? 100 : step.fill * 100}%` }"
                />
            </div>
        </div>

        <ol class="flex flex-col gap-1.5">
            <li v-for="step in steps" :key="step.key" class="flex items-center gap-2" :class="{ 'opacity-50': step.state === 'pending' }">
                <Icon :name="ICONS[step.state]" :spin="step.state === 'running'" :class="`shrink-0 ${TONES[step.state]}`" />
                <span class="min-w-0 flex-1">
                    <span class="block truncate text-2xs text-content">{{ step.label }}</span>
                    <span v-if="step.state === 'running'" class="block truncate text-2xs text-subtle">{{ detail ?? step.note }}</span>
                </span>
                <span v-if="step.seconds !== undefined" class="shrink-0 font-mono text-2xs tabular-nums text-muted">{{
                    formatElapsed(step.seconds)
                }}</span>
            </li>
        </ol>

        <slot />

        <!-- Verbatim, unsummarised, and only ever on purpose. -->
        <DeviceRunLog v-if="showLog" :lines="lines" :running="live" :empty="emptyLog" :note="logNote" />

        <div class="flex flex-wrap items-center gap-x-3">
            <button type="button" :class="ui.textButton({ tone: `quiet`, size: `xs` })" :aria-expanded="showLog" @click="showLog = !showLog">
                <Icon :name="showLog ? `chevron-down` : `chevron-right`" />{{ showLog ? hideLogLabel : showLogLabel }}
            </button>
            <button v-if="!live" type="button" :class="ui.textButton({ tone: `quiet`, size: `xs` })" @click="$emit(`dismiss`)">
                <Icon name="times" />{{ t(`ui.action.dismiss`) }}
            </button>
            <slot v-if="showLog" name="log-footer" />
        </div>
    </div>
</template>
