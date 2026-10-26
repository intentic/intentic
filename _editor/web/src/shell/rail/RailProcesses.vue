<!-- THE WORKSPACE RAIL'S TEMPORARY GROUP: the processes the desktop app runs for or beside this workspace (sign-in, this
     PC's setup, a sandbox's, a folder's, Docker, a recreate, a sync), on Home's rail and on a sandbox's (parts/processes/,
     models/processes/). Their pages are Home's, in the chat's place; from a sandbox's rail the press goes there. The
     sandbox Home is making has its own tile among the sandboxes (newSandbox/NewSandboxTile.vue), so its app run is not
     drawn twice, and a run this page holds itself is the page's own tile already. -->
<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { newSandbox } from "../../features/home/newSandbox/newSandbox";
import { ADD_SANDBOX_HOME_PATH } from "../../models/sandbox/addSandbox";
import { useFaceProcesses } from "../../models/processes/faceProcesses";
import { processAskedBy, processOnHome } from "../../models/processes/processAddress";
import { type ProcessTile, processTilesOf } from "../../models/processes/processTiles";
import ProcessTiles from "../../parts/processes/ProcessTiles.vue";

const route = useRoute();
const router = useRouter();
const { list } = useFaceProcesses();
const making = computed(() => newSandbox.value?.here.add.created.value?.id);
const tiles = computed(() =>
    processTilesOf(list.value, (report) => report.origin === `workspace` || (report.sandboxId !== undefined && report.sandboxId === making.value)),
);
const selected = computed(() => processAskedBy(route));
// Pushed, so Back returns to the chat or the screen the reader pressed it from.
const open = (tile: ProcessTile): void => {
    if (tile.report.sandboxId !== undefined && tile.report.sandboxId === making.value) {
        void router.push(ADD_SANDBOX_HOME_PATH);
        return;
    }
    if (selected.value !== tile.id) {
        void router.push(processOnHome(tile.id));
    }
};
</script>

<template>
    <ProcessTiles :tiles="tiles" :selected="selected" @open="open" />
</template>
