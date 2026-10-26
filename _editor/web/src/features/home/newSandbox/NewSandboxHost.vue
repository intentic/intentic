<!-- THE NEW SANDBOX'S RUN, held where leaving its page does not end it (newSandbox.ts says why). Mounted by the shell on a
     desktop while Home shows the page or a run is under way, keyed by `newSandboxGeneration` so a run that ended leaves
     nothing behind for the next. Draws nothing: the page and the rail's tile draw what it publishes. -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { HOME_PATH } from "../../../lib/routes/firstScreens";
import { useAddSandboxHere } from "../../setup/add/useAddSandboxHere";
import { markReady, newSandbox, newSandboxBusy, newSandboxGeneration, newSandboxShownBy, type NewSandboxRun } from "./newSandbox";

const route = useRoute();
const router = useRouter();
const watching = computed(() => newSandboxShownBy(route));

const pressed = ref(false);
const opening = ref(false);
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

const { problem, pick, creating } = here.add;
const run: NewSandboxRun = {
    here,
    pressed,
    opening,
    create: async () => {
        // A press the form would not take starts nothing, and puts up no tile that would stand for nothing.
        if (problem.value !== undefined || pick.value === undefined || creating.value) {
            return;
        }
        pressed.value = true;
        newSandboxBusy.value = true;
        await here.add.create();
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
onUnmounted(() => {
    if (newSandbox.value === run) {
        newSandbox.value = undefined;
    }
});
</script>

<template>
    <span hidden></span>
</template>
