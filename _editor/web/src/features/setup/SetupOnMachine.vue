<script setup lang="ts">
import { Button } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import type { MachineDoor } from "../sandbox/live/sandboxDoors";
import type { SetupOnMachineApi } from "./flow/useSetupOnMachine";
import SetupMachineProgress from "./SetupMachineProgress.vue";

// SET IT UP ON A COMPUTER THAT IS ALREADY CONNECTED: the card's one button once the "Runs on" row picked such a machine
// (flow/useSetupOnMachine.ts), and the run it starts there (SetupMachineProgress.vue). Once the machine claims the code,
// the page's own handoff line says the rest, as it does for a pasted command.

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
        <SetupMachineProgress :door="door" :machine="machine" />
    </div>
</template>
