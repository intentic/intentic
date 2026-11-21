<!-- A computer's screen and terminals, for a person here: one row per environment that has a command door (Windows,
     each connected distro), with its Screen and Terminal and the shells already running there, then the computer's three
     switches that allow them, and on Windows whether its lock screen and administrator prompts can be reached too.
     Drawn only for a computer that has a door at all. -->
<script setup lang="ts">
import { RowGroup } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { useTier } from "../../../../client/sandbox/useTier";
import { useCapabilities } from "../../../../models/capabilities/useCapabilities";
import type { MachineRow } from "../../../../models/sandbox/devices/deviceRows";
import { serviceSide } from "../../../../models/sandbox/devices/remote/remoteService";
import RemoteServiceRow from "./RemoteServiceRow.vue";
import RemoteSideRow from "./RemoteSideRow.vue";
import RemoteSwitches from "./RemoteSwitches.vue";

const { machine } = defineProps<{ machine: MachineRow }>();

const t = useT();
const sides = computed(() => machine.environments.filter((environment) => environment.device.hostId !== undefined));
// The Windows side, where the lock-screen service is set up; none on a computer that is not Windows.
const windows = computed(() => serviceSide(machine.environments));
// The machine's one capability card, whose switches every environment of it is admitted on; unread below maintainer,
// who sees no switches, only what they allow.
const { capabilities } = useCapabilities();
const { canShip } = useTier();
const card = computed(() => {
    const cards = new Set(machine.environments.flatMap((environment) => (environment.device.card === undefined ? [] : [environment.device.card])));
    return capabilities.value.find((capability) => cards.has(capability.id));
});
</script>

<template>
    <RowGroup v-if="sides.length > 0" :label="t(`sandbox.deviceRemote.title`)">
        <RemoteSideRow v-for="side in sides" :key="side.device.key" :row="side" :machine-key="machine.key" :machine-name="machine.label" />
        <RemoteSwitches v-if="card" :card="card" :editable="canShip" />
        <RemoteServiceRow v-if="windows" :row="windows" :machine-name="machine.label" :editable="canShip" />
    </RowGroup>
</template>
