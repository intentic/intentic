<script setup lang="ts">
import { DeviceRunLog, type IconName, Notice, type NoticeModel, ui } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { computed, ref, watch } from "vue";
import { DEV_REBUILD_STEPS, type DevRebuildStage, stageStart } from "./devRebuildStages";
import { type DevRebuildRun, rebuildElapsedLabel, rebuildRunning } from "./useDevRebuild";
import { useT } from "@intentic/ui/i18n";

// A REBUILD DRAWN AS THE THREE THINGS IT DOES, not as a wall of somebody else's build output. The log is what a reader
// reaches for when something has gone wrong, and for the other twenty minutes it is noise that hides the one fact they
// came for — so it sits behind a toggle that opens itself on a failure.
// One moving part on screen: the bar and the step list share a single spinner, on whichever step is running.

const t = useT();

const props = defineProps<{
    run: DevRebuildRun;
    /** Seconds this run has been going; undefined for one adopted mid-flight, whose start nothing here saw. */
    elapsed: number | undefined;
    /** Where the machine wrote the whole thing, for a reader whose rebuild never came back. */
    logPath: string;
}>();

defineEmits<{ dismiss: [] }>();

const live = computed(() => rebuildRunning(props.run.phase));
const now = useNow(() => live.value);

type StepState = "done" | "running" | "pending" | "stopped";

const rankOf = (stage: DevRebuildStage): number => DEV_REBUILD_STEPS.findIndex((step) => step.key === stage);

const stateOf = (stage: DevRebuildStage): StepState => {
    const here = rankOf(stage);
    const at = rankOf(props.run.stage);
    if (props.run.phase === `done`) {
        return `done`;
    }
    if (here < at) {
        return `done`;
    }
    if (here > at) {
        return `pending`;
    }
    // Where it got to and stopped: not finished, and not still going either.
    return live.value ? `running` : `stopped`;
};

// A step's own clock runs from the moment it was first seen to the moment the next one was. Both are absent for a
// build adopted mid-flight, and a step that nothing timed shows no number rather than a made-up one.
const secondsOf = (stage: DevRebuildStage): number | undefined => {
    const from = props.run.stageAt[stage];
    if (from === undefined) {
        return undefined;
    }
    const later = DEV_REBUILD_STEPS.slice(rankOf(stage) + 1)
        .map((step) => props.run.stageAt[step.key])
        .find((at) => at !== undefined);
    const to = later ?? props.run.endedAt ?? (live.value ? now.value : undefined);
    return to === undefined ? undefined : Math.max(0, Math.round((to - from) / 1000));
};

// How much of a step's own segment of the bar is filled. Zero for a step with nothing countable in it, which the
// segment then says by pulsing rather than by sitting at a number it cannot justify.
const fillOf = (stage: DevRebuildStage, weight: number): number =>
    Math.min(1, Math.max(0, (props.run.fraction - stageStart(stage)) / weight));

const steps = computed(() =>
    DEV_REBUILD_STEPS.map((step) => ({
        ...step,
        state: stateOf(step.key),
        seconds: secondsOf(step.key),
        fill: fillOf(step.key, step.weight),
    })),
);

const ICONS: Record<StepState, IconName> = { done: `check-circle`, running: `spinner`, pending: `circle`, stopped: `exclamation-triangle` };
const TONES: Record<StepState, string> = { done: `text-success`, running: `text-info`, pending: `text-muted`, stopped: `text-warning` };

const elapsedLabel = computed(() => rebuildElapsedLabel(props.elapsed));

// What the step is on this second, in the tool's own words: the package turbo is compiling, docker's layer count, the
// sentence ic printed. Only ever beside the running step, since it describes this instant and nothing else.
const detail = computed(() => {
    const { layers, detail: said } = props.run;
    if (props.run.stage === `image` && layers !== undefined) {
        return t(`sandbox.devRebuildProgress.layerOf`, { done: layers.done, total: layers.total });
    }
    return said;
});

const heading = `Rebuilding from your checkout`;

// The one sentence about THIS sandbox, which flips at the swap: up to it the build costs the reader nothing, and from
// it their workspace is the thing that went away.
const cost = computed(() => {
    if (!live.value) {
        return undefined;
    }
    return props.run.stage === `swap`
        ? `Your sandbox is restarting on the new image. This page reconnects on its own.`
        : `Your sandbox keeps working, and restarts on its own once it's built.`;
});

const done = computed(() =>
    props.run.phase === `done`
        ? `Rebuilt from your checkout in ${elapsedLabel.value ?? `a few minutes`}. You're running the new image.`
        : undefined,
);

const failure = computed<NoticeModel | undefined>(() => {
    if (props.run.phase === `failed`) {
        const title =
            props.run.exitCode === undefined
                ? `That device didn't run the rebuild.`
                : `The rebuild failed on that device (exit ${props.run.exitCode}).`;
        return { tone: `warning`, title, ...(props.run.trouble === undefined ? {} : { detail: props.run.trouble }) };
    }
    if (props.run.phase === `lost`) {
        return {
            tone: `warning`,
            title: t(`sandbox.devRebuildProgress.rebuildStoppedReportingNever`),
            detail: props.run.trouble ?? `Nothing has been written to its log for a while: the machine may have slept, or the build was stopped.`,
        };
    }
    return undefined;
});

// A docker layer builds for minutes without printing anything, so a still pane is not evidence of a stuck build — but
// after a while it is worth saying which of the two this is, rather than leaving the reader to guess.
const QUIET_AFTER_S = 90;
const quiet = computed(() => {
    const seconds = props.run.quietFor ?? 0;
    return props.run.phase === `building` && seconds > QUIET_AFTER_S
        ? `Nothing new in the log for ${Math.round(seconds / 60)}m — a single docker layer can take that long.`
        : undefined;
});

// A read that failed while the build carries on regardless: the machine's own words, not a verdict on the rebuild.
const hiccup = computed(() => (live.value ? props.run.trouble : undefined));

const showLog = ref(false);
// A failure is the one state where nobody has to ask: the lines ARE the answer, so they are already open. Immediate,
// because a card drawn onto a rebuild that failed before it mounted owes the reader the same thing.
watch(
    failure,
    (bad) => {
        if (bad !== undefined) {
            showLog.value = true;
        }
    },
    { immediate: true },
);

const logLabel = computed(() => (showLog.value ? `Hide the build log` : `Show the build log`));
</script>

<template>
    <div class="flex flex-col gap-3 rounded-lg border border-line bg-card p-3">
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
                    rebuildElapsedLabel(step.seconds)
                }}</span>
            </li>
        </ol>

        <p v-if="cost" class="text-2xs text-muted">{{ cost }}</p>

        <Notice v-if="failure" :of="failure" class="text-2xs" />
        <p v-else-if="done" class="flex items-center gap-2 text-2xs text-muted">
            <Icon name="check-circle" class="shrink-0 text-success" />
            <span>{{ done }}</span>
        </p>

        <p v-if="quiet" class="text-2xs text-subtle">{{ quiet }}</p>
        <p v-if="hiccup" class="text-2xs text-subtle">{{ t(`sandbox.devRebuildProgress.cantReadLogAt`, { hiccup }) }}</p>

        <!-- Verbatim, unsummarised, and only ever on purpose. -->
        <DeviceRunLog v-if="showLog" :lines="run.lines" :running="live" :empty="t(`sandbox.devRebuildProgress.waitingFirstLineDevice`)" />

        <div class="flex flex-wrap items-center gap-x-3">
            <button type="button" :class="ui.textAction(`text-2xs`)" @click="showLog = !showLog">
                <Icon :name="showLog ? `chevron-down` : `chevron-right`" />{{ logLabel }}
            </button>
            <button v-if="!live" type="button" :class="ui.textAction(`text-2xs`)" @click="$emit(`dismiss`)">
                <Icon name="times" />{{ t(`ui.action.dismiss`) }}
            </button>
            <!-- The whole thing outlives this card, so where it lives is worth keeping beside the tail it shows. -->
            <p v-if="showLog" class="text-2xs text-subtle">
                {{ t(`sandbox.devRebuildProgress.fullOutputIn`) }} <span class="font-mono">{{ logPath }}</span> {{ t(`sandbox.devRebuildProgress.onDevice`) }}
            </p>
        </div>
    </div>
</template>
