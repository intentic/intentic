<script setup lang="ts">
import { Button, Notice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref, watch } from "vue";
import StagedProgress from "../../components/progress/StagedProgress.vue";
import { useProgress } from "../../components/progress/useProgress";
import type { MachineDoor } from "../sandbox/live/sandboxDoors";
import type { SetupOnMachineApi } from "./flow/useSetupOnMachine";
import { useSetupRunProgress } from "./progress/useSetupRunProgress";

// SET IT UP ON A COMPUTER THAT IS ALREADY CONNECTED: the card's one button once the "Runs on" row picked such a machine
// (flow/useSetupOnMachine.ts), and the run it starts there, drawn as the steps `ic sandbox connect` takes rather than as
// the lines it prints (2026-10-21: a credential helper's complaint and a key file's path were the page's progress). The
// lines are read by the engine the desktop app reads its own install with (progress/), drawn by the card every long run
// on a machine is (<StagedProgress>), and kept one press away, opening by themselves when the run fails. Once the
// machine claims the code, the page's own handoff line says the rest, as it does for a pasted command.

const {
    door,
    machine,
    locked = false,
} = defineProps<{
    // The machine picked.
    door: MachineDoor;
    // Its run, kept in the operations ledger under this row.
    machine: Pick<SetupOnMachineApi, `run` | `setUpOn`>;
    // Something else is already on its way to a machine for this row (the app's install, a claimed code).
    locked?: boolean;
}>();

const t = useT();

const run = useSetupRunProgress({
    lines: () => machine.run.lines.value,
    running: () => machine.run.busy.value,
    failed: () => machine.run.failure.value !== undefined,
});
const progress = useProgress(
    () => run.value?.startedAt,
    () => ({ endedAt: run.value?.endedAt, measured: run.value?.measured }),
);
const heading = computed(() => {
    switch (run.value?.status) {
        case `done`:
            return t(`setup.setupRunProgress.doneOn`, { machine: door.machineLabel });
        case `stopped`:
            return t(`setup.setupOnMachine.couldntOn`, { machine: door.machineLabel });
        default:
            return t(`setup.setupOnMachine.settingUpOn`, { machine: door.machineLabel });
    }
});

const showLog = ref(false);
watch(
    () => run.value?.status,
    (status) => {
        if (status === `stopped`) {
            showLog.value = true;
        }
    },
    { immediate: true },
);
</script>

<template>
    <div class="flex flex-col gap-2" data-setup-on-machine>
        <!-- The caption shares the button's row, as "Set it up now"'s does: one row per way, not a sentence above each. -->
        <div class="flex flex-col items-stretch gap-x-4 gap-y-2 md:flex-row md:items-center">
            <Button
                :label="t(`setup.setupOnMachine.setUpOn`, { machine: door.machineLabel })"
                class="w-full shrink-0 justify-center md:w-fit"
                :loading="machine.run.busy.value"
                :disabled="machine.run.busy.value || locked"
                @click="machine.setUpOn"
            >
                <template #icon><Icon name="bolt" /></template>
            </Button>
            <p class="min-w-0 text-xs text-muted">{{ t(`setup.setupOnMachine.caption`) }}</p>
        </div>
        <StagedProgress
            v-if="run"
            v-model:log="showLog"
            :heading="heading"
            :progress="progress ?? { elapsedMs: undefined, measured: run.measured }"
            :steps="run.steps"
            :stage="run.stage"
            :stage-at="run.stageAt"
            :ended-at="run.endedAt"
            :status="run.status"
            :live="machine.run.busy.value"
            :detail="run.detail"
            :lines="machine.run.lines.value"
            :empty-log="t(`setup.setupOnMachine.startingOn`, { machine: door.machineLabel })"
            :show-log-label="t(`setup.setupRunProgress.showLog`)"
            :hide-log-label="t(`setup.setupRunProgress.hideLog`)"
            :log-note="t(`setup.setupRunProgress.outputOn`, { machine: door.machineLabel })"
            hide-dismiss
        >
            <p v-if="run.remaining && run.status === `running`" class="text-2xs text-muted">{{ run.remaining }}</p>
        </StagedProgress>
        <Notice v-if="machine.run.failure.value" :of="machine.run.failure.value" />
    </div>
</template>
