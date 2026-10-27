<script setup lang="ts">
import { DeviceRunLog, formatElapsed, type IconName, ui } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { computed } from "vue";
import { type Progress, progressShare, spanWords } from "./progress";
import { type ProgressStatus, type ProgressStep, remainingMs, type StepState, stepFill, stepSeconds, stepState } from "./stagedSteps";
import { useT } from "@intentic/ui/i18n";

// A LONG RUN DRAWN AS THE FEW THINGS IT DOES, not as a wall of somebody else's output. The log is what a reader
// reaches for when something has gone wrong, and the rest of the time it is noise that hides the one fact they came
// for — so it sits behind a toggle the caller opens on a failure. What is particular to one kind of run (its cost to the
// reader, its verdict, where its ending is written) goes in the default slot, between the steps and the log. How far
// along it is and how long it has run are the one progress model's (progress.ts): the run's own count fills the steps.
//
// ONE PICTURE OF THE STEPS, NOT TWO. A few steps are a row of columns, each its own segment of the bar with its name and
// its clock under it: the bar and a list of the same three steps beneath it said everything twice, and the clocks sat a
// card's width away from the names they belonged to. Many steps (a machine's setup) stay a list under one bar, which is
// the shape that still reads at six. The header's right edge answers the question a reader brings to a long run — how
// long is left — where the steps were measured before, and only says how long it has run where they were not.

const t = useT();

const props = defineProps<{
    /** One line for the whole run: what it is. Always the progress bar's name, even where it is not drawn. */
    heading: string;
    /** Off where the surface around it already says it (a badge reading "rebuilding"): the line then carries only the
     *  time left, and goes where there is none to say. */
    hideHeading?: boolean;
    /** How long it has run and how far its own count says it is (`measured`, never decreasing). */
    progress: Progress;
    steps: readonly ProgressStep[];
    /** The step the run is on, or the last it reached once it has ended. */
    stage: string;
    /** When each step was first seen, so the card can time a step it watched begin. */
    stageAt: Partial<Record<string, number>>;
    endedAt: number | undefined;
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
    /** Inside a surface whose own buttons put an ended run away (a dialog's footer), so there are not two. */
    hideDismiss?: boolean;
}>();

defineEmits<{ dismiss: [] }>();

// Opened by the reader, or by the caller on a failure, where the lines ARE the answer.
const showLog = defineModel<boolean>("log", { default: false });

const now = useNow(() => props.live);

const steps = computed(() => {
    const end = props.endedAt ?? (props.live ? now.value : undefined);
    return props.steps.map((step) => ({
        ...step,
        state: stepState(props.steps, step.key, props.stage, props.status),
        seconds: stepSeconds(props.steps, step.key, props.stageAt, end),
        fill: stepFill(props.steps, step.key, progressShare(props.progress) ?? 0),
    }));
});

const ICONS: Record<StepState, IconName> = {
    done: `check-circle`,
    running: `spinner`,
    pending: `circle`,
    stopped: `exclamation-triangle`,
    unheard: `question-circle`,
    held: `pause`,
};
const TONES: Record<StepState, string> = {
    done: `text-success`,
    // The one moving thing on the card, in the accent: a pending circle and a spinner in the same grey read as alike.
    running: `text-accent`,
    pending: `text-subtle`,
    stopped: `text-warning`,
    unheard: `text-warning`,
    held: `text-accent`,
};
const LABEL_TONES = {
    done: `text-muted`,
    running: `font-medium text-content`,
    pending: `text-subtle`,
    stopped: `text-content`,
    unheard: `text-content`,
    held: `font-medium text-content`,
} as const satisfies Record<StepState, string>;

// Columns while each still has room for its name; a longer plan is a list.
const columns = computed(() => props.steps.length <= 4);
const running = computed(() => steps.value.find((step) => step.state === `running` || step.state === `held`));

const elapsedLabel = computed(() => (props.progress.elapsedMs === undefined ? undefined : formatElapsed(Math.round(props.progress.elapsedMs / 1000))));

// What is left, from the steps' own last lengths; nothing at all where they were not measured.
const left = computed(() => {
    const step = running.value;
    if (!props.live || step === undefined || step.state !== `running`) {
        return undefined;
    }
    return remainingMs(props.steps, step.key, step.seconds === undefined ? undefined : step.seconds * 1000);
});

const figure = computed(() => {
    const remaining = left.value;
    if (remaining === undefined) {
        return elapsedLabel.value;
    }
    // The step it is on has outlasted its own length, which its own clock beside it shows; the whole run's elapsed time
    // here would read as the run being late when only the step is.
    if (remaining.overdue) {
        return t(`common.waitProgress.overdue`);
    }
    return t(`common.waitProgress.left`, { left: spanWords(Math.max(5_000, remaining.ms)) });
});

// A step's clock: what it took, what it has run (against what it took last time), or what it took last time.
const clockOf = (step: (typeof steps.value)[number]): string | undefined => {
    const usual = step.expectedMs === undefined ? undefined : formatElapsed(Math.round(step.expectedMs / 1000));
    // What a step took last time is a promise about the run still going; on one that ended it is noise.
    if (step.state === `pending` || (step.state === `held` && step.seconds === undefined)) {
        return usual === undefined || (!props.live && step.state === `pending`) ? undefined : `~${usual}`;
    }
    if (step.seconds === undefined) {
        return undefined;
    }
    const took = formatElapsed(step.seconds);
    return step.state === `running` && usual !== undefined ? t(`common.waitProgress.figureOfUsual`, { elapsed: took, usual }) : took;
};

// Without its heading the top line is only worth a row for the time left. "Longer than usual" is already the running
// step's own clock ("11m 6s / ~45s"), and how long it has run is the sum of the clocks under each step.
const leftLine = computed(() => (left.value === undefined || left.value.overdue ? undefined : figure.value));

// What the running step is on this second goes under its own name, not on a row of its own across the card.
const detailOf = (step: (typeof steps.value)[number]): string | undefined => (step === running.value ? (props.detail ?? step.note) || undefined : undefined);

const share = computed(() => Math.round((progressShare(props.progress) ?? 0) * 100));
// The bar to a screen reader: the step it is on and what is left, in the words the card shows.
const spoken = computed(() => [running.value?.label, figure.value].filter((part) => part !== undefined).join(`, `));
</script>

<template>
    <!-- No card of its own: it is drawn inside a group that is already a surface, and a second border there is chrome. -->
    <div class="flex flex-col gap-3">
        <!-- One line for the whole run: what it is, and how long it has left (or has been going). -->
        <div v-if="!hideHeading" class="flex items-baseline gap-2">
            <span class="flex-1 text-xs font-medium text-content">{{ heading }}</span>
            <span v-if="figure" class="shrink-0 font-mono text-2xs tabular-nums text-muted">{{ figure }}</span>
        </div>
        <p v-else-if="leftLine" class="text-xs text-muted first-letter:uppercase">{{ leftLine }}</p>

        <!-- Read out once per step, not once per second: the label changes when the step does. -->
        <span class="sr-only" aria-live="polite">{{ running?.label }}</span>

        <!-- The steps as columns, each its own segment of the bar, sized by how long that step takes (by its last run
             where one was measured) on top of the room its name needs, so a full segment means a finished step rather
             than a share of an arbitrary total. On a narrow pane the step it is on keeps its whole name and the others
             give way. A running step with nothing countable in it pulses instead of claiming a number. -->
        <ol
            v-if="columns"
            class="flex gap-1"
            role="progressbar"
            :aria-label="heading"
            aria-valuemin="0"
            aria-valuemax="100"
            :aria-valuenow="share"
            :aria-valuetext="spoken"
        >
            <li
                v-for="step in steps"
                :key="step.key"
                class="flex min-w-16 max-w-[60%] flex-col gap-1.5"
                :style="{ flexGrow: step.weight, flexShrink: step === running ? 0 : 1, flexBasis: `auto` }"
            >
                <div
                    class="h-1.5 overflow-hidden rounded-full"
                    :class="step.state === 'running' && step.fill === 0 ? `animate-pulse bg-primary-400/30` : `bg-canvas`"
                >
                    <div
                        class="h-full rounded-full transition-[width] duration-500 ease-out"
                        :class="step.state === 'stopped' ? `bg-warning` : `bg-primary-400`"
                        :style="{ width: `${step.state === 'done' ? 100 : step.fill * 100}%` }"
                    />
                </div>
                <span class="flex min-w-0 items-center gap-1.5">
                    <Icon :name="ICONS[step.state]" :spin="step.state === 'running'" :class="`shrink-0 text-2xs ${TONES[step.state]}`" />
                    <span class="min-w-0 truncate text-2xs" :class="LABEL_TONES[step.state]" :title="step.label">{{ step.label }}</span>
                </span>
                <span v-if="clockOf(step)" class="truncate pl-5 font-mono text-2xs tabular-nums" :class="step.state === 'running' ? `text-muted` : `text-subtle`">{{
                    clockOf(step)
                }}</span>
                <!-- Width-neutral (w-0 min-w-full): a package name changing every second must not move the bar. -->
                <span v-if="detailOf(step)" class="w-0 min-w-full truncate pl-5 text-2xs text-subtle" :title="detailOf(step)">{{ detailOf(step) }}</span>
            </li>
        </ol>

        <!-- A longer plan: one bar, then the steps as a list with the running one's detail under it. -->
        <template v-if="!columns">
            <div
                class="flex h-1.5 gap-0.5 overflow-hidden rounded-full"
                role="progressbar"
                :aria-label="heading"
                aria-valuemin="0"
                aria-valuemax="100"
                :aria-valuenow="share"
                :aria-valuetext="spoken"
            >
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
                <li v-for="step in steps" :key="step.key" class="flex items-center gap-2">
                    <Icon :name="ICONS[step.state]" :spin="step.state === 'running'" :class="`shrink-0 ${TONES[step.state]}`" />
                    <span class="min-w-0 flex-1">
                        <span class="block truncate text-2xs" :class="LABEL_TONES[step.state]">{{ step.label }}</span>
                        <span v-if="step.state === 'running'" class="block truncate text-2xs text-subtle">{{ detail ?? step.note }}</span>
                    </span>
                    <span v-if="clockOf(step)" class="shrink-0 font-mono text-2xs tabular-nums text-muted">{{ clockOf(step) }}</span>
                </li>
            </ol>
        </template>

        <slot />

        <!-- Verbatim, unsummarised, and only ever on purpose. -->
        <DeviceRunLog v-if="showLog" :lines="lines" :running="live" :empty="emptyLog" :note="logNote" />

        <!-- Every quiet action on one row: the log, what the caller adds (a cancel), and at the far edge the way out
             of trouble. Keep the text buttons' expanded tap targets inside the content's scroll bounds. -->
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5">
            <button type="button" :class="ui.textButton({ tone: `quiet`, size: `xs` })" :aria-expanded="showLog" @click="showLog = !showLog">
                <Icon :name="showLog ? `chevron-down` : `chevron-right`" />{{ showLog ? hideLogLabel : showLogLabel }}
            </button>
            <slot name="actions" />
            <button v-if="!live && !hideDismiss" type="button" :class="ui.textButton({ tone: `quiet`, size: `xs` })" @click="$emit(`dismiss`)">
                <Icon name="times" />{{ t(`ui.action.dismiss`) }}
            </button>
            <slot v-if="showLog" name="log-footer" />
            <span v-if="$slots[`actions-end`]" class="ml-auto"><slot name="actions-end" /></span>
        </div>
    </div>
</template>
