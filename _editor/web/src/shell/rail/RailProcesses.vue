<!-- THE WORKSPACE RAIL'S TEMPORARY GROUP: the processes the desktop app runs for or beside this workspace (sign-in, this
     PC's setup, a sandbox's, a folder's, Docker, a recreate, a sync), on Home's rail and on a sandbox's (parts/processes/,
     models/processes/). Their pages are Home's, in the chat's place; from a sandbox's rail the press goes there. The
     sandbox Home is making has its own tile among the sandboxes (newSandbox/NewSandboxTile.vue), so its app run is not
     drawn twice, and a run this page holds itself is the page's own tile already. A sandbox Home's rail already has a tile
     for (`tiled`) carries its own runs on that tile while they work (processTiles.ts `foldedOnSandbox`), and its setup,
     once finished, is put away here rather than left as a "done" tile beside it: the sandbox's tile is marked ready
     instead, unless it is the one on screen. -->
<script setup lang="ts">
import { computed, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { markReady, newSandbox } from "../../features/home/newSandbox/newSandbox";
import { useSandbox } from "../../client/sandbox/useSandbox";
import { ADD_SANDBOX_HOME_PATH } from "../../models/sandbox/addSandbox";
import { useFaceProcesses } from "../../models/processes/faceProcesses";
import { processAskedBy, processOnHome } from "../../models/processes/processAddress";
import { foldedOnSandbox, type ProcessTile, processTilesOf, settledSetups } from "../../models/processes/processTiles";
import ProcessTiles from "../../parts/processes/ProcessTiles.vue";

const { tiled = new Set<string>() } = defineProps<{ tiled?: ReadonlySet<string> }>();
const route = useRoute();
const router = useRouter();
const sandbox = useSandbox();
const { list, act } = useFaceProcesses();
const making = computed(() => newSandbox.value?.here.add.created.value?.id);
const tiles = computed(() =>
    processTilesOf(
        list.value,
        (report) =>
            report.origin === `workspace` || (report.sandboxId !== undefined && report.sandboxId === making.value) || foldedOnSandbox(report, tiled),
    ),
);
// Each finished setup put away once: the app's list answers the press a moment later, and is not pressed again meanwhile.
const putAway = new Set<string>();
watch(
    () => settledSetups(list.value, tiled, sandbox.activeSandboxId.value),
    (done) => {
        // Gone from the list: a later setup of the same sandbox is put away in its turn.
        for (const id of putAway) {
            if (!done.some((report) => report.id === id)) {
                putAway.delete(id);
            }
        }
        for (const report of done) {
            if (putAway.has(report.id) || report.sandboxId === undefined) {
                continue;
            }
            putAway.add(report.id);
            if (report.sandboxId !== sandbox.activeSandboxId.value) {
                markReady(report.sandboxId);
            }
            act(report, `dismiss`);
        }
    },
    { immediate: true },
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
