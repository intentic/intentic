<script setup lang="ts">
import { Button, DeviceRunLog, Notice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { useOperation } from "../../workbench/operations/operations";
import { manageDeviceSandbox } from "../sandbox/devices/useDevices";
import { type MachineDoor, setupDoors } from "../sandbox/live/sandboxDoors";
import { useDeviceRelays } from "../sandbox/live/useDeviceRelays";

// SET IT UP ON A COMPUTER THAT IS ALREADY CONNECTED, with a press instead of the command. Any of the owner's sandboxes
// that reaches an online machine able to list its containers (so `ic` and an engine answer there) can run the same
// `ic sandbox connect` the command runs, with this row's code: the `create` op `sandboxes create --on` already uses.
// What the machine prints streams under the press; once it claims the code, the page's own handoff says the rest, as it
// does for a pasted command. The caller offers this only where the press does what the command would.

const props = defineProps<{
    // The row being set up, which keys the run in the ledger.
    sandboxId: string;
    // The minted code and the hostname it names; the slug is that hostname's first label.
    code: string;
    hostname: string;
    // Desktop sync was asked for: the press does not set it up, so it says so rather than dropping it silently.
    syncAsked: boolean;
}>();

const t = useT();

// Every sandbox of the owner's, read fresh as the page opens and kept read while it stays.
const { relays, look } = useDeviceRelays({ follow: true });
void look();
const doors = computed(() => setupDoors(relays.value));

const run = useOperation<string>(() => `setup/${props.sandboxId}/on-machine`);
const pressedOn = ref<string>();
const setUpOn = async (door: MachineDoor): Promise<void> => {
    if (run.busy.value) {
        return;
    }
    pressedOn.value = door.machineLabel;
    const slug = props.hostname.split(`.`)[0] ?? ``;
    await run.run({
        what: t(`setup.setupOnMachine.settingUpOn`, { machine: door.machineLabel }),
        failed: t(`setup.setupOnMachine.couldntOn`, { machine: door.machineLabel }),
        task: async (report) => await manageDeviceSandbox(door.hostId, slug, `create`, { setupCode: props.code, at: door.relay, onLine: report.line }),
    });
};
</script>

<template>
    <div v-if="doors.length > 0" class="flex flex-col gap-2" data-setup-on-machine>
        <p class="text-xs text-muted">{{ t(`setup.setupOnMachine.alreadyConnected`) }}</p>
        <div class="flex flex-wrap gap-2">
            <Button
                v-for="door in doors"
                :key="door.machineKey"
                :tier="doors.length > 1 ? `boring` : undefined"
                :label="t(`setup.setupOnMachine.setUpOn`, { machine: door.machineLabel })"
                :loading="run.busy.value && pressedOn === door.machineLabel"
                :disabled="run.busy.value"
                @click="setUpOn(door)"
            >
                <template #icon><Icon name="bolt" /></template>
            </Button>
        </div>
        <p v-if="syncAsked" class="text-2xs text-subtle">{{ t(`setup.setupOnMachine.syncAfter`) }}</p>
        <DeviceRunLog
            v-if="run.busy.value || run.lines.value.length > 0"
            :lines="run.lines.value"
            :running="run.busy.value"
            :empty="t(`setup.setupOnMachine.startingOn`, { machine: pressedOn ?? `` })"
        />
        <Notice v-if="run.failure.value" :of="run.failure.value" />
    </div>
</template>
