<!-- The Devices view's full-page screen (`?device=<machine>&screen=<connection>&monitor=<id>`, deviceLinks.ts
     screenRoute): which computer, which of its monitors, and the way back to its page, around DeviceScreen. The monitor
     picked is in the address, so a reload or a shared link opens the same one. -->
<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { deviceRoute, screenRoute, selectedKey } from "../../../../models/sandbox/devices/deviceLinks";
import { useRemoteStatus } from "../../../../models/sandbox/devices/remote/remoteApi";
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
</script>

<template>
    <DeviceScreen
        v-if="connection !== ``"
        :key="connection"
        v-model:monitor="monitor"
        :device="connection"
        :name="name"
        :monitors="monitors"
        :back="deviceRoute(machineKey)"
    />
</template>
