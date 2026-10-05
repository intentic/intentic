<!-- A FOLDER'S WAY TO AN AGENT, AS THIS WINDOW ASKS FOR IT AND WATCHES IT: the dialog, and the card of this computer's
     sandbox and this folder going into it, in the corner where the window's notifications ride (shell/notifications), so
     the two share one lane rather than stacking over each other. Mounted once, by the window's shell (LocalShell.vue), so
     the card stays in sight whichever screen of the window the reader moves to. -->
<script setup lang="ts">
import { onMounted, onUnmounted } from "vue";
import { LOCAL_PROJECT_ASK_EVENT } from "../app/environments/local";
import { hold } from "../shell/notifications/notifications";
import LocalMachineCard from "./LocalMachineCard.vue";
import LocalProjectDialog from "./LocalProjectDialog.vue";
import { useLocalProject } from "./useLocalProject";

const { card, ask } = useLocalProject();

// The card stands in the lane exactly as long as there is something to say; its own box, its own buttons.
const release = hold(`local-machine-sandbox`, () => (card.value === undefined ? undefined : { kind: `condition`, title: card.value.title, card: LocalMachineCard }));

// The app asking for this window's dialog (its project.rs `start`, for "Work on this with an agent" asked by link).
const asked = (): void => void ask();
onMounted(() => window.addEventListener(LOCAL_PROJECT_ASK_EVENT, asked));
onUnmounted(() => {
    window.removeEventListener(LOCAL_PROJECT_ASK_EVENT, asked);
    release();
});
</script>

<template>
    <LocalProjectDialog />
</template>
