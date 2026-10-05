<!-- A FOLDER'S OWN SANDBOX, AS THIS WINDOW ASKS FOR IT AND WATCHES IT GO UP: the dialog, and the build's card in the
     corner where the window's notifications ride (shell/notifications), so the two share one lane rather than stacking
     over each other. Mounted once, by the window's shell (LocalShell.vue), so the build stays in sight whichever screen
     of the window the reader moves to. -->
<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { onMounted, onUnmounted } from "vue";
import { LOCAL_PROJECT_ASK_EVENT } from "../app/environments/local";
import { hold } from "../shell/notifications/notifications";
import LocalProjectBuild from "./LocalProjectBuild.vue";
import LocalProjectDialog from "./LocalProjectDialog.vue";
import { useLocalProject } from "./useLocalProject";

const t = useT();
const { build, ask } = useLocalProject();

// The build's card stands in the lane exactly as long as there is a build to draw; its own box, its own buttons.
const release = hold(`local-project-build`, () =>
    build.value === undefined ? undefined : { kind: `condition`, title: t(`local.project.${build.value.state}`, { name: build.value.name }), card: LocalProjectBuild },
);

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
