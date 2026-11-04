<script setup lang="ts">
import { Button, formatElapsed } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed, ref, watch } from "vue";
import StagedProgress from "../../../../components/progress/StagedProgress.vue";
import { useProgress } from "../../../../components/progress/useProgress";
import DeviceUpdateProgress from "./DeviceUpdateProgress.vue";
import { type RunnerFlow, runnerRunView } from "./runnerStages";

// A RUNNER BEING ADDED, UPDATED OR REMOVED, drawn with the card every long run on a machine gets (<StagedProgress>):
// the few steps `ic` takes, a bar sized by them, each step's own clock, and the machine's output one press away,
// opening by itself when the run stops. An update is a sandbox update and is drawn by that row's own card
// (<DeviceUpdateProgress>); adding and removing are read by runnerStages.ts. A refusal's notice and the line to type on
// the machine stay under the card (<DeviceOpFailure>), so this card says only how far it got and how it ended.

const t = useT();

const props = defineProps<{
    flow: RunnerFlow;
    /** Still running on the machine, as far as the ledger knows. */
    live: boolean;
    /** The machine's output so far, from the ledger. */
    lines: readonly string[];
    /** The machine's name, which is where the run carries on with nobody watching. */
    machine: string;
    /** The machine's last word. */
    outcome: string | undefined;
    /** The added runner has dialled in and shows online in the list above. */
    paired: boolean;
    /** Try again is offered: the machine is reachable and nothing else is running on it. */
    canRetry: boolean;
}>();

defineEmits<{ dismiss: []; retry: [] }>();

const heading = computed(() => {
    const name = props.flow.name;
    switch (props.flow.op) {
        case `create`:
            return t(`sandbox.deviceRunners.adding`, { name });
        case `remove`:
            return t(`sandbox.deviceRunners.removing`, { name });
        default:
            return t(`sandbox.deviceRunners.updating`, { name });
    }
});

// Adding and removing; an update's run is its own card's to read.
const run = computed(() => (props.flow.op === `update` ? undefined : props.flow.run));
const now = useNow(() => props.live);
const view = computed(() => (run.value === undefined ? undefined : runnerRunView(run.value, now.value)));
const progress = useProgress(
    () => run.value?.progress.startedAt,
    () => ({ endedAt: run.value?.endedAt, measured: view.value?.measured }),
);

// Stopped on a refusal, which is when the lines are the answer and when trying again means something. A run whose
// stream dropped may still be finishing out there, so it is neither.
const stopped = computed(() => (props.flow.op === `update` ? props.flow.run.phase === `failed` : view.value?.status === `stopped`));

// While it runs: what is left where the engine can say, and that leaving the page stops nothing.
const going = computed(() => {
    if (!props.live) {
        return undefined;
    }
    const carries = t(`sandbox.runnerProgress.carriesOn`, { machine: props.machine });
    const left = props.flow.op === `create` ? view.value?.remaining : undefined;
    return left === undefined ? carries : `${left} · ${carries}`;
});

// How it ended, said once and timed. An added runner still has to dial in before the list above shows it online.
const ended = computed(() => {
    if (view.value?.status !== `done`) {
        return undefined;
    }
    const elapsed = formatElapsed(Math.round((progress.value?.elapsedMs ?? 0) / 1000));
    if (props.flow.op === `remove`) {
        return t(`sandbox.runnerProgress.removedIn`, { elapsed });
    }
    return props.paired ? t(`sandbox.runnerProgress.addedIn`, { elapsed }) : t(`sandbox.runnerProgress.addedPairing`, { elapsed });
});

const showLog = ref(false);
watch(
    stopped,
    (on) => {
        if (on) {
            showLog.value = true;
        }
    },
    { immediate: true },
);
</script>

<template>
    <DeviceUpdateProgress
        v-if="flow.op === `update`"
        :run="flow.run"
        :name="flow.name"
        :heading="heading"
        :machine="machine"
        :self="false"
        :outcome="outcome"
        @dismiss="$emit(`dismiss`)"
    >
        <template v-if="stopped && canRetry" #actions-end>
            <Button size="small" tier="boring" :label="t(`ui.action.tryAgain`)" @click="$emit(`retry`)">
                <template #icon><Icon name="refresh" /></template>
            </Button>
        </template>
    </DeviceUpdateProgress>
    <StagedProgress
        v-else-if="run && view"
        v-model:log="showLog"
        :heading="heading"
        :progress="progress ?? { elapsedMs: undefined, measured: view.measured }"
        :steps="view.steps"
        :stage="view.stage"
        :stage-at="run.stageAt"
        :ended-at="run.endedAt"
        :status="view.status"
        :live="live"
        :detail="view.detail"
        :lines="lines"
        :empty-log="t(`sandbox.devicePage.startingOnDevice`)"
        :show-log-label="t(`sandbox.deviceUpdateProgress.showLog`)"
        :hide-log-label="t(`sandbox.deviceUpdateProgress.hideLog`)"
        :log-note="t(`sandbox.deviceUpdateProgress.outputOn`, { machine })"
        @dismiss="$emit(`dismiss`)"
    >
        <p v-if="going" class="text-2xs text-muted first-letter:uppercase">{{ going }}</p>
        <p v-else-if="ended" class="flex items-center gap-2 text-2xs text-muted">
            <Icon name="check-circle" class="shrink-0 text-success" />
            <span>{{ ended }}</span>
        </p>
        <template v-if="stopped && canRetry" #actions-end>
            <Button size="small" tier="boring" :label="t(`ui.action.tryAgain`)" @click="$emit(`retry`)">
                <template #icon><Icon name="refresh" /></template>
            </Button>
        </template>
    </StagedProgress>
</template>
