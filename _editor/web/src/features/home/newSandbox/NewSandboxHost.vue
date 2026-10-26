<!-- THE NEW SANDBOX'S RUN, held where leaving its page does not end it (newSandbox.ts says why). Mounted by the shell on a
     desktop while Home asks for the new sandbox or a run is under way, keyed by `newSandboxGeneration` so a run that
     ended leaves nothing behind for the next. Draws nothing: the dialog, the page and the rail's tile draw what it
     publishes. Once the press has gone somewhere it closes the dialog by taking the ask out of Home's address, so the
     reader is back on the chat they were in; a first sandbox, with no chat to go back to, keeps its page. An address
     asking to finish a setup left unfinished (`?finish=<id>`) is that press, made for the reader: no dialog, the row's
     own run on this computer. -->
<script setup lang="ts">
import type { SandboxSummary } from "@intentic/api-contract";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { HOME_PATH } from "../../../lib/routes/firstScreens";
import { switchableSandboxes, unfinishedSandboxes } from "../../../models/sandbox/live/roster";
import { useAddSandboxHere } from "../../setup/add/useAddSandboxHere";
import { finishAskedBy, markReady, newSandbox, newSandboxBusy, newSandboxGeneration, newSandboxShownBy, type NewSandboxRun } from "./newSandbox";

const route = useRoute();
const router = useRouter();
const watching = computed(() => newSandboxShownBy(route));

const pressed = ref(false);
const opening = ref(false);
const resumed = ref(false);
// The row being finished, kept for a press again after its code was refused.
let finished: SandboxSummary | undefined;
// How the run ended, decided once: whatever answers after that (a navigation this host made, a late report) is not news.
let settled = false;

// Over: the shell mounts the next host if Home still asks for one, and none otherwise.
const end = (): void => {
    newSandboxBusy.value = false;
    newSandboxGeneration.value += 1;
};

// Home's own chat again, where the new sandbox is selected (opened) or the one the reader had is (dismissed).
const leave = async (): Promise<void> => {
    if (watching.value) {
        await router.replace(HOME_PATH);
    }
    end();
};

// In the reader's list now, a tile like the rest; one they were not watching says it is ready until it is opened.
const readyUnseen = (sandboxId: string): void => {
    if (settled) {
        return;
    }
    settled = true;
    markReady(sandboxId);
    end();
};

const here = useAddSandboxHere({
    appStays: true,
    // Only a reader looking at it is moved onto it; one back in another sandbox's chat stays there.
    selects: () => watching.value,
    reportedIn: (sandboxId) => {
        if (watching.value) {
            opening.value = true;
            return;
        }
        readyUnseen(sandboxId);
    },
});
onMounted(() => void here.add.read());

// Left while its first start was still on screen: it is ready enough to be a tile, and the reader chose another.
watch(watching, (now) => {
    const id = here.add.created.value?.id;
    if (!now && opening.value && id !== undefined) {
        readyUnseen(id);
    }
});

// Started: the dialog goes, and the reader with another sandbox is back on its chat while the tile carries the run. The
// address is replaced, not pushed, so Back still leads where it led before the + was pressed.
const sandbox = useSandbox();
watch(
    () => here.add.started.value !== undefined,
    (now, before) => {
        const id = here.add.created.value?.id;
        const others = switchableSandboxes(sandbox.sandboxes.value).some((box) => box.id !== id);
        if (now && !before && watching.value && others) {
            void router.replace(HOME_PATH);
        }
    },
);

const { problem, pick, creating } = here.add;
const run: NewSandboxRun = {
    here,
    pressed,
    opening,
    resumed,
    create: async () => {
        // A press the form would not take starts nothing, and puts up no tile that would stand for nothing.
        if (problem.value !== undefined || pick.value === undefined || creating.value) {
            return;
        }
        pressed.value = true;
        newSandboxBusy.value = true;
        await here.add.create();
    },
    resume: async (row) => {
        if (creating.value || here.add.started.value !== undefined) {
            return;
        }
        finished = row;
        resumed.value = true;
        pressed.value = true;
        newSandboxBusy.value = true;
        await here.add.resume(row);
    },
    retry: () => {
        if (resumed.value && here.add.started.value === undefined && finished !== undefined) {
            void run.resume(finished);
            return;
        }
        void here.add.retry();
    },
    opened: () => {
        if (settled || here.add.created.value === null) {
            return;
        }
        settled = true;
        void leave();
    },
    dismiss: () => {
        if (settled) {
            return;
        }
        settled = true;
        void leave();
    },
};
newSandbox.value = run;

// Asked by the address to finish a row: pressed for the reader once the account's list names it as theirs and unfinished.
// A row the list does not offer (a stale link, someone else's) asks nothing, and Home's chat comes back.
watch(
    () => [finishAskedBy(route), sandbox.sandboxes.value] as const,
    ([asked, rows]) => {
        if (asked === undefined || pressed.value) {
            return;
        }
        const row = unfinishedSandboxes(rows).find((entry) => entry.id === asked);
        if (row !== undefined) {
            void run.resume(row);
        } else {
            void router.replace(HOME_PATH);
        }
    },
    { immediate: true },
);
onUnmounted(() => {
    if (newSandbox.value === run) {
        newSandbox.value = undefined;
    }
});
</script>

<template>
    <span hidden></span>
</template>
