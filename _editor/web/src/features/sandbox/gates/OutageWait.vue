<script setup lang="ts">
import { computed } from "vue";
import ProgressMeter from "../../../components/progress/ProgressMeter.vue";
import type { Progress } from "../../../components/progress/progress";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { RESTART_PATIENCE_MS, restartExpected } from "../../../models/sandbox/live/sandboxRestart";
import { USUAL_RESTART_MS } from "./connectionNotice";
import { useDiagnosisNotice, useVisibleOutage } from "./useVisibleOutage";
import { useOutageDetails } from "../diagnosis/useOutageDetails";

// The outage card's body in the notification lane while the outage is still a wait: the same clock, estimate and
// details the connecting gate draws under its sentence, over a workspace that stays on screen. A restart this browser
// asked for speaks first, as its card does (notificationSources.ts `restartCard`), and the diagnosis after it.

const { active } = useSandbox();
const outage = useVisibleOutage();
const notice = useDiagnosisNotice(outage);
const details = useOutageDetails(outage);

const wait = computed<Progress | undefined>(() => {
    const elapsedMs = outage.elapsed.value;
    if (restartExpected(active.value?.id) !== undefined && elapsedMs < RESTART_PATIENCE_MS) {
        return { elapsedMs, expectedMs: USUAL_RESTART_MS, giveUpMs: RESTART_PATIENCE_MS };
    }
    return notice.value?.waiting === true ? notice.value.wait : undefined;
});
</script>

<template>
    <ProgressMeter v-if="wait" :progress="wait" :details="details" />
</template>
