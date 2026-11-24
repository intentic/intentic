<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from "vue";
import { dockerStarting, engineListening, listError, sandboxes } from "../machine";
import { running as runActive } from "../runs";
import BackgroundRows from "./BackgroundRows.vue";
import {
    engineAppStarting,
    engineBackgroundShown,
    engineModeError,
    engineModeSetting,
    engineMoving,
    engineState,
    engineToggleError,
    engineToggling,
    followEngineBackground,
    loadEngine,
    setEngineMode,
    startEngineNow,
    stopEngineNow,
} from "./engine";

// RUNS IN THE BACKGROUND, as This computer holds it (engine.ts, machine.ts): BackgroundRows.vue draws it, this hands it
// the store. Mounted whether or not it is shown, so a change made in the tray is heard on a page that had nothing to show.

const mode = computed(() => (engineBackgroundShown.value ? (engineState.value?.mode ?? undefined) : undefined));
// Counted only while the engine answers and docker listed what is on it: an empty list from a stopped engine says nothing.
const listed = computed(() => engineListening.value === true && listError.value === undefined);
const count = computed(() => (listed.value ? sandboxes.value.length : undefined));
const runningCount = computed(() => (listed.value ? sandboxes.value.filter((sandbox) => sandbox.running).length : undefined));
const busy = computed(() => runActive.value || engineMoving.value !== undefined);

let stopFollowing: (() => void) | undefined;
onMounted(() => {
    stopFollowing = followEngineBackground();
});
onBeforeUnmount(() => stopFollowing?.());

// The engine started or stopped between two of the page's looks, and nothing here did it: ic says why (a hold, and which).
watch(engineListening, (now, before) => {
    if (before !== undefined && now !== before && engineBackgroundShown.value && engineToggling.value === undefined && engineModeSetting.value === undefined) {
        void loadEngine();
    }
});
</script>

<template>
    <BackgroundRows
        v-if="mode && engineState"
        :mode="mode"
        :status="engineState"
        :listening="engineListening"
        :starting="dockerStarting || engineAppStarting"
        :sandboxes="count"
        :running="runningCount"
        :setting="engineModeSetting"
        :mode-error="engineModeError"
        :toggling="engineToggling"
        :toggle-error="engineToggleError"
        :busy="busy"
        @mode="(next) => void setEngineMode(next)"
        @stop="() => void stopEngineNow()"
        @start="() => void startEngineNow()"
    />
</template>
