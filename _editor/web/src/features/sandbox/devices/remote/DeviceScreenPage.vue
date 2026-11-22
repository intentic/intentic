<!-- The Devices view's full-page screen (`?device=<machine>&screen=<connection>&monitor=<id>`, deviceLinks.ts
     screenRoute): which computer, which of its monitors, and the way back to its page, around DeviceScreen. The monitor
     picked is in the address, so a reload or a shared link opens the same one. From here the screen moves beside the
     section or into a window of its own (screenPlaces.ts), and the page goes back to the computer's: one picture of a
     computer on screen, one stream from it. -->
<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { deviceRoute, screenRoute, selectedKey } from "../../../../models/sandbox/devices/deviceLinks";
import { useRemoteStatus } from "../../../../models/sandbox/devices/remote/remoteApi";
import { primaryMonitor } from "../../../../models/sandbox/devices/remote/remoteOffers";
import { openScreenBeside, openScreenWindow, type ScreenAt, type ScreenMoves } from "../../../../models/sandbox/devices/remote/screenPlaces";
import { useDevices } from "../../../../models/sandbox/devices/useDevices";
import DeviceScreen from "./DeviceScreen.vue";

const route = useRoute();
const router = useRouter();
const machineKey = computed(() => selectedKey(route.query[`device`]) ?? ``);
const connection = computed(() => selectedKey(route.query[`screen`]) ?? ``);
const { devices } = useDevices();
// The computer as its page names it; its connection's own name until the list is read.
const name = computed(() => devices.value.find((device) => device.hostId === connection.value)?.label ?? connection.value);
const status = useRemoteStatus(() => (connection.value === `` ? undefined : connection.value));
const monitors = computed(() => status.data.value?.monitors ?? []);

const monitor = computed({
    get: () => selectedKey(route.query[`monitor`]),
    set: (id) => void router.replace(screenRoute(machineKey.value, connection.value, id)),
});

const at = (): ScreenAt => ({ machine: machineKey.value, device: connection.value, name: name.value, monitor: monitor.value });
const moves: ScreenMoves = {
    beside: () => {
        if (openScreenBeside(at())) {
            void router.push(deviceRoute(machineKey.value));
        }
    },
    window: () => {
        const shown = monitors.value.find((each) => each.id === monitor.value) ?? primaryMonitor(monitors.value);
        const opened = openScreenWindow(at(), shown);
        if (opened) {
            void router.push(deviceRoute(machineKey.value));
        }
        return opened;
    },
};
</script>

<template>
    <DeviceScreen
        v-if="connection !== ``"
        :key="connection"
        v-model:monitor="monitor"
        place="page"
        :device="connection"
        :name="name"
        :monitors="monitors"
        :back="deviceRoute(machineKey)"
        :moves="moves"
    />
</template>
