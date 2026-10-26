<script setup lang="ts">
import { Button, Code, commandLang, ConfirmDialog, formatElapsed, Notice, type NoticeModel, Picker, type PickerOption, ui } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { computed, ref, watch } from "vue";
import StagedProgress from "../../../../components/progress/StagedProgress.vue";
import type { Progress } from "../../../../components/progress/progress";
import type { ProgressStatus } from "../../../../components/progress/stagedSteps";
import { type DevRebuildStage, reweigh } from "./devRebuildStages";
import type { TimedStep } from "./rebuildHistory";
import { type DevRebuildRun, outOfContact, rebuildRunning } from "./useDevRebuild";
import { useT } from "@intentic/ui/i18n";

// A REBUILD DRAWN AS THE THREE THINGS IT DOES (<StagedProgress>, which a device's update shares), with what only a
// rebuild has to say beside it. Laid out by the questions a reader brings to it, in the order they bring them: is it
// working (the steps), how long (the header's time left, from the last run's own lengths), what it will cost me (the
// restart, and who is mid-turn when it lands), and can I change my mind (when it restarts, and Cancel). Then how it
// ended, and where its ending is written once this page can no longer read it. The log opens itself on a failure.

export type SwapPolicy = "built" | "idle" | "manual";

const t = useT();

const props = defineProps<{
    run: DevRebuildRun;
    /** Seconds this run has been going; undefined for one adopted mid-flight, whose start nothing here saw. */
    elapsed: number | undefined;
    /** Where the machine wrote the whole thing, for a reader whose rebuild never came back. */
    logPath: string;
    /** The sandbox's name as `ic` knows it on that machine, for the lines that read the outcome there. */
    slug: string;
    /** The three steps, sized and timed by the last run this browser watched (rebuildHistory.ts). */
    steps: readonly TimedStep[];
    /** Turbo's task count last time, for "23 of ~48" before this compile has said its own total. */
    pastTasks: number | undefined;
    /** When the restart happens; undefined where the machine has no swap gate to hold it at (an older daemon). */
    policy: SwapPolicy | undefined;
    /** A change of policy or a release on its way to the machine. */
    policyBusy: boolean;
    /** The machine's or the sandbox's sentence when one was refused. */
    policyTrouble: string | undefined;
    /** Who an idle-wait is waiting on, by the names the board shows. */
    waitingOn: readonly string[];
    /** Agents mid-turn right now, which the restart would cut. */
    midTurn: number;
    /** Whether a cut turn resumes by itself after a restart. */
    autoResume: boolean;
    /** A cancel on its way to the machine, and its refusal. */
    cancelling: boolean;
    cancelTrouble: string | undefined;
}>();

const emit = defineEmits<{ dismiss: []; "update:policy": [policy: SwapPolicy]; restartNow: []; cancel: [] }>();

const live = computed(() => rebuildRunning(props.run.phase));
const now = useNow(() => live.value);

// The restart step gone unheard-from past the patience a swap gets. From here the card stops promising a reconnect it
// cannot see coming and says where the ending is written instead, while the follow keeps asking underneath.
const unheard = computed(() => outOfContact(props.run, now.value));

// A gate holding, the build done: the image step is finished and the restart is reached but not begun, held on the
// owner or an idle fleet. Its clock stops where the hold began, since what runs on from there is the owner's time.
const waiting = computed(() => live.value && props.run.waiting);

// The status the steps are drawn in: not known to be going nor known to have stopped is the step this page lost sight
// of; where it got to and stopped is not finished, and not still going either.
const status = computed<ProgressStatus>(() => {
    if (props.run.phase === `done`) {
        return `done`;
    }
    if (unheard.value) {
        return `unheard`;
    }
    if (waiting.value) {
        return `held`;
    }
    return live.value ? `running` : `stopped`;
});

// A finished rebuild finished every step, whichever marker its last tail happened to end on; a held one is at the
// restart without having started it.
const stage = computed(() => (props.run.phase === `done` || waiting.value ? `swap` : props.run.stage));
const endedAt = computed(() => props.run.endedAt ?? (waiting.value ? props.run.waitingSince : undefined));

// The run's own count fills the steps; the follower keeps it in fixed shares, the bar draws it in the last run's.
const weightOf = (key: DevRebuildStage): number => props.steps.find((step) => step.key === key)?.weight ?? 0;
const weights = computed(() => ({ compile: weightOf(`compile`), image: weightOf(`image`), swap: weightOf(`swap`) }));
const progress = computed<Progress>(() => ({
    elapsedMs: props.elapsed === undefined ? undefined : props.elapsed * 1000,
    measured: reweigh(props.run.fraction, props.run.stage, weights.value),
}));

// What the step is on this second, in the tool's own words — the package turbo is compiling, with how many of its tasks
// have started; docker's layer count; the sentence ic printed. Only ever beside the running step.
const detail = computed(() => {
    const { layers, tasks, detail: said, stage: on } = props.run;
    // Held at the gate, the strip below says it all: the image's last layer count is history by now.
    if (waiting.value) {
        return ``;
    }
    if (on === `image` && layers !== undefined) {
        return t(`sandbox.devRebuildProgress.layerOf`, { done: layers.done, total: layers.total });
    }
    if (on === `compile` && tasks !== undefined && tasks.started > 0) {
        // Turbo's own total once its summary says it; until then the last run's, marked as the approximation it is.
        const past = props.pastTasks;
        const count =
            tasks.total !== undefined
                ? t(`sandbox.devRebuildProgress.packagesOf`, { started: Math.min(tasks.started, tasks.total), total: tasks.total })
                : past !== undefined
                  ? t(`sandbox.devRebuildProgress.packagesOfAbout`, { started: Math.min(tasks.started, past), total: past })
                  : t(`sandbox.devRebuildProgress.packages`, { count: tasks.started }, tasks.started);
        return said === undefined ? count : `${said} · ${count}`;
    }
    // In the restart, ic's own narration when it has said something, and nothing otherwise: the line under the card
    // already says the sandbox is restarting and that this page comes back on its own.
    return on === `swap` ? (said ?? ``) : said;
});

// The run's state as the heading: the group above already says "Built from your checkout", so this says where it is.
const heading = computed(() => {
    switch (props.run.phase) {
        case `done`:
            return t(`sandbox.devRebuildProgress.headingDone`);
        case `failed`:
            return t(`sandbox.devRebuildProgress.headingFailed`);
        case `cancelled`:
            return t(`sandbox.devRebuildProgress.headingCancelled`);
        case `lost`:
            return t(`sandbox.devRebuildProgress.headingLost`);
        default:
            if (waiting.value) {
                return t(`sandbox.devRebuildProgress.headingWaiting`);
            }
            return props.run.stage === `swap` ? t(`sandbox.devRebuildProgress.headingSwapping`) : t(`sandbox.devRebuildProgress.headingBuilding`);
    }
});

// The gate let the swap through, or the narration says the swap is on: from here nothing may stop the build.
const swapping = computed(() => props.run.swapping || (props.run.stage === `swap` && !props.run.waiting));
const cancellable = computed(() => live.value && !swapping.value && props.run.phase !== `starting`);
const choosing = computed(() => live.value && !swapping.value && !waiting.value && props.policy !== undefined);

const POLICY_OPTIONS = computed(
    () =>
        [
            { value: `built`, label: t(`sandbox.devRebuildProgress.policyBuilt`), icon: `bolt`, hint: t(`sandbox.devRebuildProgress.policyBuiltHint`) },
            { value: `idle`, label: t(`sandbox.devRebuildProgress.policyIdle`), icon: `users`, hint: t(`sandbox.devRebuildProgress.policyIdleHint`) },
            { value: `manual`, label: t(`sandbox.devRebuildProgress.policyManual`), icon: `pause`, hint: t(`sandbox.devRebuildProgress.policyManualHint`) },
        ] as const satisfies readonly PickerOption<SwapPolicy>[],
);
const policyModel = computed({
    get: () => props.policy,
    set: (next: SwapPolicy | undefined) => {
        if (next !== undefined && next !== props.policy) {
            emit(`update:policy`, next);
        }
    },
});

// WHAT THE RESTART COSTS, read now rather than when it lands. Only said where it still decides something: under "as
// soon as it's built" the restart will cut whoever is mid-turn when it comes; under "once no agent is mid-turn" the
// question is who it is waiting on; under "when I say" the owner is the one who will look.
const cost = computed(() => {
    if (!live.value || unheard.value) {
        return undefined;
    }
    if (swapping.value) {
        return t(`sandbox.devRebuildProgress.restartingOnNewImage`);
    }
    if (props.policy === undefined) {
        return t(`sandbox.devRebuildProgress.keepsWorking`);
    }
    if (props.policy === `idle`) {
        return props.waitingOn.length > 0 ? t(`sandbox.devRebuildProgress.waitingOn`, { names: props.waitingOn.join(`, `) }) : undefined;
    }
    if (props.policy === `built` && props.midTurn > 0) {
        return props.autoResume
            ? t(`sandbox.devRebuild.midTurnResumed`, { count: props.midTurn }, props.midTurn)
            : t(`sandbox.devRebuild.midTurnLost`, { count: props.midTurn }, props.midTurn);
    }
    return undefined;
});

// Built and held: the one moment the owner is the thing the build is waiting on, so it is said as a strip with its button.
const held = computed(() => {
    if (!waiting.value) {
        return undefined;
    }
    return props.policy === `idle` ? t(`sandbox.devRebuildProgress.builtWaitingIdle`) : t(`sandbox.devRebuildProgress.builtWaitingManual`);
});

const done = computed(() => {
    if (props.run.phase === `cancelled`) {
        return t(`sandbox.devRebuildProgress.cancelledLine`);
    }
    if (props.run.phase !== `done`) {
        return undefined;
    }
    return props.elapsed === undefined
        ? t(`sandbox.devRebuildProgress.rebuiltFewMinutes`)
        : t(`sandbox.devRebuildProgress.rebuiltIn`, { elapsed: formatElapsed(props.elapsed) });
});

const failure = computed<NoticeModel | undefined>(() => {
    if (props.run.phase === `failed`) {
        const title =
            props.run.exitCode === undefined
                ? t(`sandbox.devRebuildProgress.deviceDidntRun`)
                : t(`sandbox.devRebuildProgress.failedOnDevice`, { code: props.run.exitCode });
        return { tone: `warning`, title, ...(props.run.trouble === undefined ? {} : { detail: props.run.trouble }) };
    }
    if (props.run.phase === `lost` && unheard.value) {
        const said = [t(`sandbox.devRebuildProgress.lostContactGaveUp`), props.run.trouble].filter((line) => line !== undefined).join(`\n`);
        return { tone: `warning`, title: t(`sandbox.devRebuildProgress.lostContact`), detail: said };
    }
    if (props.run.phase === `lost`) {
        return {
            tone: `warning`,
            title: t(`sandbox.devRebuildProgress.rebuildStoppedReportingNever`),
            detail: props.run.trouble ?? t(`sandbox.devRebuildProgress.logSilent`),
        };
    }
    return undefined;
});

// Still following, still unheard-from: the same words while the polls go on, and no log thrown open — this is not a
// failure until something says so.
const adrift = computed<NoticeModel | undefined>(() =>
    live.value && unheard.value
        ? { tone: `warning`, title: t(`sandbox.devRebuildProgress.lostContact`), detail: t(`sandbox.devRebuildProgress.lostContactRetrying`) }
        : undefined,
);
const notice = computed(() => failure.value ?? adrift.value);

// WHERE THE ENDING IS, once this page cannot read it: the build's own log, which `ic` finishes with its verdict on the
// swap; the new container's log, which says why it would not come up; and `ic`'s diagnosis of both. All on the machine
// that runs the rebuild, which wrote the ending down whether or not anyone here was listening — there is no other way
// to it, since the machine agent reaches this sandbox through the same daemon. Spelled bare, as deviceFallback.ts
// spells them: ic's installer puts it on the PATH.
const outcomeCommands = computed(() => [`tail -n 40 ${props.logPath}`, `ic sandbox logs ${props.slug}`, `ic sandbox doctor ${props.slug}`].join(`\n`));

// A docker layer builds for minutes without printing anything, so a still pane is not evidence of a stuck build — but
// after a while it is worth saying which of the two this is, rather than leaving the reader to guess.
const QUIET_AFTER_S = 90;
const quiet = computed(() => {
    const seconds = props.run.quietFor ?? 0;
    return props.run.phase === `building` && !unheard.value && seconds > QUIET_AFTER_S
        ? t(`sandbox.devRebuildProgress.quietFor`, { minutes: Math.round(seconds / 60) })
        : undefined;
});

// A read that failed while the build carries on regardless: the machine's own words, not a verdict on the rebuild.
const hiccup = computed(() => (live.value ? props.run.trouble : undefined));

// "Having trouble?" is the way back to an earlier image. A build going well needs none, so it is offered once something
// is wrong, or once the run has ended and the image it built is the thing that might be.
const troubled = computed(() => !live.value || unheard.value || quiet.value !== undefined);

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

const confirmingCancel = ref(false);
const confirmCancel = (): void => {
    confirmingCancel.value = false;
    emit(`cancel`);
};
</script>

<template>
    <StagedProgress
        v-model:log="showLog"
        :heading="heading"
        :progress="progress"
        :steps="steps"
        :stage="stage"
        :stage-at="run.stageAt"
        :ended-at="endedAt"
        :status="status"
        :live="live && !waiting"
        :detail="detail"
        :lines="run.lines"
        :empty-log="t(`sandbox.devRebuildProgress.waitingFirstLineDevice`)"
        :show-log-label="t(`sandbox.devRebuildProgress.showLog`)"
        :hide-log-label="t(`sandbox.devRebuildProgress.hideLog`)"
        :hide-dismiss="live"
        @dismiss="$emit(`dismiss`)"
    >
        <!-- Built and held at the gate: the image is ready and the sandbox untouched, waiting on the owner or an idle fleet. -->
        <div v-if="held" class="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md bg-primary-600/10 px-3 py-2">
            <span class="min-w-0 flex-1 text-2xs text-content">{{ held }}</span>
            <Button :label="t(`sandbox.devRebuildProgress.restartNow`)" size="small" tier="accent" :loading="policyBusy" @click="$emit(`restartNow`)">
                <template #icon><Icon name="refresh" /></template>
            </Button>
        </div>

        <!-- When the restart lands, decided where it is read and changeable until the build gets there. -->
        <div v-if="choosing" class="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span class="text-2xs text-muted">{{ t(`sandbox.devRebuildProgress.restartLabel`) }}</span>
            <Picker
                v-model="policyModel"
                :options="POLICY_OPTIONS"
                variant="ghost"
                :disabled="policyBusy"
                :aria-label="t(`sandbox.devRebuildProgress.restartLabel`)"
                class="text-2xs"
            />
        </div>
        <p v-if="cost" class="text-2xs text-muted">{{ cost }}</p>
        <p v-if="policyTrouble" class="text-2xs text-warning">{{ policyTrouble }}</p>

        <div v-if="notice" class="flex flex-col gap-1.5">
            <Notice :of="notice" class="text-2xs" />
            <!-- Under the notice, not inside it: the notice is the reason, these are the way to the answer. -->
            <Code
                v-if="unheard"
                :code="outcomeCommands"
                :lang="commandLang(`unix`)"
                :label="t(`sandbox.devRebuildProgress.outcomeOnMachine`)"
                :wrap="true"
            />
        </div>
        <p v-else-if="done" class="flex items-center gap-2 text-2xs text-muted">
            <Icon :name="run.phase === `done` ? `check-circle` : `times-circle`" :class="`shrink-0 ${run.phase === `done` ? `text-success` : `text-subtle`}`" />
            <span>{{ done }}</span>
        </p>

        <p v-if="quiet" class="text-2xs text-subtle">{{ quiet }}</p>
        <p v-if="hiccup" class="text-2xs text-subtle">{{ t(`sandbox.devRebuildProgress.cantReadLogAt`, { hiccup }) }}</p>
        <p v-if="cancelTrouble" class="text-2xs text-warning">{{ cancelTrouble }}</p>

        <template #actions>
            <button
                v-if="cancellable"
                type="button"
                :class="ui.textButton({ tone: `quiet`, size: `xs` })"
                :disabled="cancelling"
                @click="confirmingCancel = true"
            >
                <Icon :name="cancelling ? `spinner` : `times-circle`" :spin="cancelling" />{{ t(`sandbox.devRebuildProgress.cancelRebuild`) }}
            </button>
        </template>
        <template #actions-end>
            <slot v-if="troubled" name="trouble" />
        </template>

        <!-- The whole thing outlives this card, so where it lives is worth keeping beside the tail it shows. -->
        <template #log-footer>
            <p class="text-2xs text-subtle">
                {{ t(`sandbox.devRebuildProgress.fullOutputIn`) }} <span class="font-mono">{{ logPath }}</span>
                {{ t(`sandbox.devRebuildProgress.onDevice`) }}
            </p>
        </template>
    </StagedProgress>

    <ConfirmDialog
        :open="confirmingCancel"
        :header="t(`sandbox.devRebuildProgress.cancelHeader`)"
        :description="t(`sandbox.devRebuildProgress.cancelBody`)"
        header-icon="times-circle"
        :confirm-label="t(`sandbox.devRebuildProgress.cancelRebuild`)"
        @cancel="confirmingCancel = false"
        @confirm="confirmCancel"
    />
</template>
