<!-- A PROCESS'S PAGE ON HOME, in the chat's place while its tile is selected (`/home?process=<id>`,
     models/processes/processAddress.ts): the app's run drawn and answered here, never by sending the reader to This
     computer. What it made opens here too: a sandbox ready is selected and its home conversation takes the page. Taking
     a sandbox to a machine of ours instead is Home's own new-sandbox dialog, for a run with no sandbox yet (this PC's
     setup); one that has its sandbox asks the app to move that one. -->
<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import type { ProcessAction, ProcessReport } from "../../app/environments/processes/processReport";
import { useSandbox } from "../../client/sandbox/useSandbox";
import { HOME_PATH } from "../../lib/routes/firstScreens";
import { useFaceProcesses } from "../../models/processes/faceProcesses";
import { processAskedBy } from "../../models/processes/processAddress";
import { ADD_SANDBOX_QUERY, ADD_SANDBOX_VALUE } from "../../models/sandbox/addSandbox";
import ProcessPage from "../../parts/processes/ProcessPage.vue";
import { seenReady } from "./newSandbox/newSandbox";

const route = useRoute();
const router = useRouter();
const sandbox = useSandbox();
const processes = useFaceProcesses();
const report = computed(() => processes.list.value.find((entry) => entry.id === processAskedBy(route)));

// What it made, opened on Home: the sandbox selected and its home conversation in this page's place; the run is done
// with, so it leaves the rail.
const openMade = async (made: ProcessReport & { readonly sandboxId: string }): Promise<void> => {
    seenReady(made.sandboxId);
    sandbox.select(made.sandboxId);
    processes.act(made, `dismiss`);
    await router.replace(HOME_PATH);
};

const answer = (act: ProcessAction, need?: string): void => {
    const current = report.value;
    if (current === undefined) {
        return;
    }
    if (act === `open` && current.sandboxId !== undefined) {
        void openMade({ ...current, sandboxId: current.sandboxId });
        return;
    }
    // No sandbox to move yet: a machine of ours is a new one, made on Home as any other.
    if (act === `use-hosted` && current.sandboxId === undefined) {
        void router.push({ path: HOME_PATH, query: { [ADD_SANDBOX_QUERY]: ADD_SANDBOX_VALUE, machine: `hosted` } });
        return;
    }
    processes.act(current, act, need);
    if (act === `dismiss` || act === `cancel`) {
        void router.replace(HOME_PATH);
    }
};
</script>

<template>
    <ProcessPage :report="report" data-home-process @act="answer" />
</template>
