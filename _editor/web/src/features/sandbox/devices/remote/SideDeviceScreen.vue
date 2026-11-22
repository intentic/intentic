<!-- A computer's screen in a tab of the side panel (screenPlaces.ts SCREEN_SIDE_VIEW), beside whichever section the rail
     picks: the same live screen and toolbar as its full page, narrower. The panel's own bar names it and holds "Open in
     Devices"; the toolbar adds the move to a window of its own. Out of sight behind another tab the computer stops
     sending, and while its full page is open in the section (the tab steps aside then) no stream is held here at all. -->
<script setup lang="ts">
import { computed } from "vue";
import type { LineJump } from "../../../../models/workspace/tabs/workspaceTabs";
import { primaryMonitor } from "../../../../models/sandbox/devices/remote/remoteOffers";
import { useRemoteStatus } from "../../../../models/sandbox/devices/remote/remoteApi";
import { openScreenBeside, openScreenWindow, SCREEN_SIDE_VIEW, ScreenAtSchema, type ScreenMoves } from "../../../../models/sandbox/devices/remote/screenPlaces";
import { useDevices } from "../../../../models/sandbox/devices/useDevices";
import { sideTabId, type SideInput } from "../../../../workbench/side/sideTabs";
import { shownSideActive, shownSideTabs } from "../../../../workbench/side/sideViews";
import DeviceScreen from "./DeviceScreen.vue";

// The side panel's contract for every body.
const { input } = defineProps<{ input: SideInput; jump?: LineJump }>();

const at = computed(() => ScreenAtSchema.safeParse(input).data);
const id = computed(() => sideTabId(SCREEN_SIDE_VIEW, input));
// Drawn at all only while its tab is (not stepped aside for the full page); sending only while it is the tab in front.
const held = computed(() => shownSideTabs.value.some((tab) => tab.id === id.value));
const visible = computed(() => shownSideActive.value === id.value);

const { devices } = useDevices();
// The name the page has for it now, else the one it was opened with.
const name = computed(() => devices.value.find((device) => device.hostId === at.value?.device)?.label ?? at.value?.name ?? ``);
const status = useRemoteStatus(() => at.value?.device);
const monitors = computed(() => status.data.value?.monitors ?? []);

// Another monitor is the same computer's tab showing something else, in its place on the strip.
const monitor = computed({
    get: () => at.value?.monitor,
    set: (picked) => {
        if (at.value !== undefined) {
            openScreenBeside({ ...at.value, name: name.value, monitor: picked });
        }
    },
});

// Into a window of its own, which takes this tab away once it holds the screen (openScreenWindow).
const moves = computed<ScreenMoves>(() => ({
    window: () => {
        const now = at.value;
        const shown = monitors.value.find((each) => each.id === now?.monitor) ?? primaryMonitor(monitors.value);
        return now === undefined || openScreenWindow({ ...now, name: name.value }, shown);
    },
}));
</script>

<template>
    <DeviceScreen
        v-if="at && held"
        v-model:monitor="monitor"
        place="beside"
        :device="at.device"
        :name="name"
        :monitors="monitors"
        :visible="visible"
        :moves="moves"
    />
</template>
