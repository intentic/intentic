<script setup lang="ts">
import { formatElapsed } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { computed, ref, watch } from "vue";
import StagedProgress from "../../progress/StagedProgress.vue";
import type { ProgressStatus } from "../../progress/stagedProgress";
import { type DeviceUpdateRun, stagedSteps, updateDetail } from "./deviceUpdateStages";
import { useT } from "@intentic/ui/i18n";

// AN UPDATE OR A ROLLBACK ON ONE ROW OF THE DEVICES PAGE, drawn as the steps `ic` takes rather than as the wall of
// docker and `intentic:` lines it prints: the same card the checkout rebuild draws (<StagedProgress>). The lines are
// one press away, and open by themselves when the run fails, where they are the answer. A refusal's own notice and the
// line to type on the machine stay under the row (<DeviceOpFailure>), so this card says nothing about why.

const t = useT();

const props = defineProps<{
    run: DeviceUpdateRun;
    /** The sandbox's name, as its row titles it. */
    name: string;
    /** The machine it runs on, which is where the run carries on with nobody watching. */
    machine: string;
    /** The sandbox serving this page: its restart takes the page's own connection with it. */
    self: boolean;
    /** The machine's last word, for a run that ended before it needed to restart anything. */
    outcome: string | undefined;
}>();

defineEmits<{ dismiss: [] }>();

const live = computed(() => props.run.phase === `running`);
const now = useNow(() => live.value);
const steps = computed(() => stagedSteps(props.run.verb));
const lastStep = computed(() => steps.value.at(-1)?.key);

const STATUS: Record<DeviceUpdateRun[`phase`], ProgressStatus> = {
    running: `running`,
    done: `done`,
    failed: `stopped`,
    // The swap is under way out of this page's sight: not known done, and not known stuck either.
    severed: `unheard`,
};

const elapsed = computed(() => Math.max(0, Math.round(((props.run.endedAt ?? now.value) - props.run.startedAt) / 1000)));
const heading = computed(() =>
    props.run.verb === `update`
        ? t(`sandbox.deviceUpdateProgress.updating`, { name: props.name })
        : t(`sandbox.deviceUpdateProgress.rollingBack`, { name: props.name }),
);

// The one sentence about what the run costs right now, which flips at the swap: up to it the sandbox works as before.
const cost = computed(() => {
    if (!live.value) {
        return undefined;
    }
    if (props.run.stage === `swap`) {
        return props.self ? t(`sandbox.deviceUpdateProgress.restartingSelf`) : t(`sandbox.deviceUpdateProgress.restarting`, { name: props.name });
    }
    return t(`sandbox.deviceUpdateProgress.keepsWorking`, { name: props.name, machine: props.machine });
});

// How it ended, said once. A run that reached the swap and came back is timed; one that stopped short of it (already
// on the newest image) or lost sight of it (the page's own sandbox) has the machine's sentence to say instead.
const ended = computed(() => {
    if (props.run.phase === `done` && props.run.stage === lastStep.value) {
        const at = formatElapsed(elapsed.value);
        return {
            icon: `check-circle` as const,
            tone: `text-success`,
            text:
                props.run.verb === `update`
                    ? t(`sandbox.deviceUpdateProgress.updatedIn`, { elapsed: at })
                    : t(`sandbox.deviceUpdateProgress.rolledBackIn`, { elapsed: at }),
        };
    }
    if ((props.run.phase === `done` || props.run.phase === `severed`) && props.outcome !== undefined) {
        return {
            icon: props.run.phase === `done` ? (`check-circle` as const) : (`info-circle` as const),
            tone: props.run.phase === `done` ? `text-success` : `text-info`,
            text: props.outcome,
        };
    }
    return undefined;
});

const showLog = ref(false);
watch(
    () => props.run.phase,
    (phase) => {
        if (phase === `failed`) {
            showLog.value = true;
        }
    },
    { immediate: true },
);
</script>

<template>
    <StagedProgress
        v-model:log="showLog"
        :heading="heading"
        :elapsed="elapsed"
        :steps="steps"
        :stage="run.stage"
        :stage-at="run.stageAt"
        :ended-at="run.endedAt"
        :fraction="run.fraction"
        :status="STATUS[run.phase]"
        :live="live"
        :detail="updateDetail(run)"
        :lines="run.lines"
        :empty-log="t(`sandbox.devicePage.startingOnDevice`)"
        :show-log-label="t(`sandbox.deviceUpdateProgress.showLog`)"
        :hide-log-label="t(`sandbox.deviceUpdateProgress.hideLog`)"
        :log-note="t(`sandbox.deviceUpdateProgress.outputOn`, { machine })"
        @dismiss="$emit(`dismiss`)"
    >
        <p v-if="cost" class="text-2xs text-muted">{{ cost }}</p>
        <p v-else-if="ended" class="flex items-center gap-2 text-2xs text-muted">
            <Icon :name="ended.icon" class="shrink-0" :class="ended.tone" />
            <span class="whitespace-pre-line">{{ ended.text }}</span>
        </p>
    </StagedProgress>
</template>
