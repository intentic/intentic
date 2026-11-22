<!-- A computer's screen in a window of its own (`/s/<sandbox>/floating/screen?machine=&device=&name=&monitor=`, opened by
     screenPlaces.ts openScreenWindow): the screen and its toolbar, nothing around it, to keep on a second monitor or
     beside other work. The window runs the screen, not a second app (lib/windows/windowRole.ts `screen`), remembers
     where it was left so the next one for this computer opens there, and hands the screen back to the window that opened
     it ("Bring back"), which shows it on its full page. -->
<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { computed, onMounted, onUnmounted, watchEffect } from "vue";
import { useRoute, useRouter } from "vue-router";
import { closeOwnWindow } from "../../../../app/environments/desktop";
import { selectedKey } from "../../../../models/sandbox/devices/deviceLinks";
import { useRemoteStatus } from "../../../../models/sandbox/devices/remote/remoteApi";
import { onScreenWindowNote, openerWindow, screenFrameKey, type ScreenAt, type ScreenMoves, sendScreenHome } from "../../../../models/sandbox/devices/remote/screenPlaces";
import { useDevices } from "../../../../models/sandbox/devices/useDevices";
import { rememberOwnFrame } from "../../../../workbench/window/floating";
import DeviceScreen from "./DeviceScreen.vue";

const t = useT();
const route = useRoute();
const router = useRouter();

const machine = computed(() => selectedKey(route.query[`machine`]) ?? ``);
const connection = computed(() => selectedKey(route.query[`device`]) ?? ``);
const { devices } = useDevices();
// The name the page has for it now, else the one the window was opened with.
const name = computed(() => devices.value.find((device) => device.hostId === connection.value)?.label ?? selectedKey(route.query[`name`]) ?? connection.value);
const status = useRemoteStatus(() => (connection.value === `` ? undefined : connection.value));
const monitors = computed(() => status.data.value?.monitors ?? []);

const at = (): ScreenAt => ({ machine: machine.value, device: connection.value, name: name.value, monitor: selectedKey(route.query[`monitor`]) });
const show = (next: ScreenAt): void => void router.replace({ query: { machine: next.machine, device: next.device, name: next.name, monitor: next.monitor } });

const monitor = computed({
    get: () => selectedKey(route.query[`monitor`]),
    set: (id) => show({ ...at(), monitor: id }),
});

// What the taskbar and the window switcher call it: whose screen, so two of them are told apart.
watchEffect(() => {
    document.title = `${name.value} · ${t(`sandbox.deviceRemote.screen`)}`;
});

// Position changes fire no event, so the frame is written when it can matter: a resize, and the way out.
const remember = (): void => {
    if (connection.value !== ``) {
        rememberOwnFrame(screenFrameKey(connection.value));
    }
};
onMounted(() => {
    window.addEventListener(`resize`, remember);
    window.addEventListener(`pagehide`, remember);
});
// The desktop app keeps one window for every screen (it names a window by its panel): asked for another computer, this
// one shows it.
const stopNotes = onScreenWindowNote(show);
onUnmounted(() => {
    remember();
    window.removeEventListener(`resize`, remember);
    window.removeEventListener(`pagehide`, remember);
    stopNotes();
});

// Back to the window that opened this one, where there still is one to take it (the desktop app's window has none).
const moves: ScreenMoves =
    openerWindow() === undefined
        ? {}
        : {
              home: () => {
                  if (sendScreenHome(at())) {
                      remember();
                      closeOwnWindow();
                  }
              },
          };
</script>

<template>
    <div class="flex h-screen w-screen flex-col overflow-hidden">
        <DeviceScreen
            v-if="connection !== ``"
            :key="connection"
            v-model:monitor="monitor"
            place="window"
            :device="connection"
            :name="name"
            :monitors="monitors"
            :moves="moves"
        />
    </div>
</template>
