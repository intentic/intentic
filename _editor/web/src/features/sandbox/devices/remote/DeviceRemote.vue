<!-- A computer's screen and terminals, for a person here: one row per environment that has a command door (Windows,
     each connected distro), with its Screen and Terminal and the shells already running there, and on Windows whether
     its lock screen and administrator prompts can be reached too. Drawn only for a computer that has a door at all.

     Who may see the screen, use the mouse and keyboard, or open terminals is the computer's capability card's to say
     (remoteView, remoteControl, remoteTerminal), beside every other permission it holds, and is not repeated here as
     switches: a row says which one is off, and the group's Permissions link opens that card's form. -->
<script setup lang="ts">
import { Button, Icon, RowGroup } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { useTier } from "../../../../client/sandbox/useTier";
import { hostEntry } from "../../../../models/sandbox/devices/deviceFacts";
import { capabilityRoute } from "../../../../models/sandbox/devices/deviceLinks";
import type { MachineRow } from "../../../../models/sandbox/devices/deviceRows";
import { serviceSide } from "../../../../models/sandbox/devices/remote/remoteService";
import RemoteServiceRow from "./RemoteServiceRow.vue";
import RemoteSideRow from "./RemoteSideRow.vue";

const { machine } = defineProps<{ machine: MachineRow }>();

const t = useT();
const sides = computed(() => machine.environments.filter((environment) => environment.device.hostId !== undefined));
// The Windows side, where the lock-screen service is set up; none on a computer that is not Windows.
const windows = computed(() => serviceSide(machine.environments));
const { canShip } = useTier();
// The machine's card form, where its remote-access switches live; a maintainer's link only, since below that the form
// is read-only and the rows already say what is off.
const permissions = computed(() => {
    const device = machine.environments.find((environment) => environment.device.card !== undefined)?.device;
    const entry = hostEntry(device?.platform);
    return canShip.value && device?.card !== undefined && entry !== undefined ? capabilityRoute(entry, { edit: device.card }) : undefined;
});
</script>

<template>
    <RowGroup v-if="sides.length > 0" :label="t(`sandbox.deviceRemote.title`)">
        <template v-if="permissions" #actions>
            <Button :as="RouterLink" :to="permissions" size="small" tier="quiet" :label="t(`sandbox.deviceRemote.permissions`)">
                <template #icon><Icon name="arrow-up-right" /></template>
            </Button>
        </template>
        <RemoteSideRow v-for="side in sides" :key="side.device.key" :row="side" :machine-key="machine.key" :machine-name="machine.label" />
        <RemoteServiceRow v-if="windows" :row="windows" :machine-name="machine.label" :editable="canShip" />
    </RowGroup>
</template>
