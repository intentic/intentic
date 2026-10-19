<script setup lang="ts">
import { DeviceRunLog } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import WaitProgress from "../../../../components/WaitProgress.vue";
import { useWaitClock } from "../../../../components/useWaitClock";

// A container verb's live output on a device row, with how long it has run above it: `ic` and docker on somebody's
// own computer can go quiet for minutes, and a log that had stopped printing read as a press that had stopped working.

const { lines, running, startedAt } = defineProps<{
    readonly lines: readonly string[];
    readonly running: boolean;
    // When the verb began (deviceOps.ts `verbStartedAt`); undefined once it has ended, or for a log kept after it.
    readonly startedAt: number | undefined;
}>();

const t = useT();
const wait = useWaitClock(() => (running ? startedAt : undefined));
</script>

<template>
    <div class="flex flex-col gap-1.5">
        <WaitProgress v-if="wait" :wait="wait" />
        <DeviceRunLog :lines="lines" :running="running" :empty="t(`sandbox.devicePage.startingOnDevice`)" :note="t(`sandbox.words.runningOnDeviceKeeps`)" />
    </div>
</template>
