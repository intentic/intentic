<!-- The agents a press elsewhere is starting, leading the Active lane until each one's own card arrives (boardLaunches.ts).
     Outside the board's row reveal: there from its first frame, since the reader was sent here to see exactly this. -->
<script setup lang="ts">
import { useRouter } from "vue-router";
import { type AgentLaunch, dismissLaunch } from "../../../../models/fleet/launches/agentLaunches";
import LaunchCard from "./LaunchCard.vue";

const { launching, dense = false } = defineProps<{ launching: readonly AgentLaunch[]; dense?: boolean }>();

const router = useRouter();
// A refused card's way back to where the press was made, which is where the refusal is acted on (a re-run, a model pick).
const back = (launch: AgentLaunch, path: string): void => {
    dismissLaunch(launch.key);
    void router.push(path);
};
</script>

<template>
    <div v-if="launching.length > 0" class="flex flex-col gap-3.5 pb-2.5">
        <LaunchCard
            v-for="launch in launching"
            :key="launch.key"
            :launch="launch"
            :dense="dense"
            @dismiss="dismissLaunch(launch.key)"
            @back="(path) => back(launch, path)"
        />
    </div>
</template>
