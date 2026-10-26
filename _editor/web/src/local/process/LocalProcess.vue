<!-- A PROCESS'S PAGE IN A LOCAL WINDOW (`/process/<id>`, models/processes/processAddress.ts): the same page Home draws in
     the chat's place, answered here, in this window. What it made opens on the reader's press: a sandbox opens in the
     workspace, in this window's place, which is the one press that goes there. Devices keeps its fuller card for the
     app's own runs on this computer, one press away. -->
<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { RouterLink, useRouter } from "vue-router";
import { localHost } from "../../app/environments/localHost";
import type { ProcessAction } from "../../app/environments/processes/processReport";
import { useFaceProcesses } from "../../models/processes/faceProcesses";
import ProcessPage from "../../parts/processes/ProcessPage.vue";

// The process the route names (`props: true`, router/index.ts).
const { id } = defineProps<{ id: string }>();
const t = useT();
const router = useRouter();
const host = localHost();
const processes = useFaceProcesses();
const report = computed(() => processes.list.value.find((entry) => entry.id === id));
// The runs whose fuller card is Devices' (the app's own work on this computer).
const DEVICE_KINDS = new Set([`sandbox-setup`, `pc-setup`, `docker`, `recreate`, `fix`, `sync`, `engine-move`]);
const devices = computed(() => host.views.find((view) => view.section === `devices`));
const onDevices = computed(() => report.value !== undefined && report.value.origin === `app` && DEVICE_KINDS.has(report.value.kind) && devices.value !== undefined);

const answer = (act: ProcessAction, need?: string): void => {
    const current = report.value;
    if (current === undefined) {
        return;
    }
    // The sandbox it made, opened where sandboxes are: the reader's own press, so the window takes the workspace.
    if (act === `open` && current.sandboxId !== undefined) {
        processes.act(current, `dismiss`);
        void host.openWorkspace(`/?sandbox=${encodeURIComponent(current.sandboxId)}`);
        return;
    }
    processes.act(current, act, need);
    if (act === `dismiss` || act === `cancel`) {
        void router.replace(`/workspace`);
    }
};
</script>

<template>
    <ProcessPage :report="report" data-local-process @act="answer">
        <RouterLink v-if="onDevices && devices" :to="`/${devices.path}`" class="w-fit text-xs text-link hover:underline">{{
            t(`processes.page.devices`)
        }}</RouterLink>
    </ProcessPage>
</template>
