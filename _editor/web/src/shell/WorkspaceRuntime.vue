<script setup lang="ts">
import { loadChunk, useDevice } from "@intentic/ui";
import { defineAsyncComponent, onMounted, onUnmounted, watch } from "vue";
import { useRoute } from "vue-router";
import { useChat } from "../features/chat/run/useChat";
import { floatingWindowPanel } from "../workbench/window/floating";
import { onScreen } from "../workbench/window/onScreen";
import { awayFromWindow } from "../workbench/window/inputAway";
import { startBackgroundLoader, stopBackgroundLoader } from "../router/prefetch/useBackgroundLoader";
import { startDraftingReceipts } from "../features/workspace/changes/commit/draftingReceipts";
import { reportAway, reportIdle, reportSessionId, reportView } from "../workbench/presence/usePresence";
import { useSandboxLiveness } from "../features/sandbox/overview/useSandboxLiveness";
import { offerTimezone } from "../features/sandbox/overview/offerTimezone";
import { startRestartWatch } from "../features/sandbox/live/restartWatch";
import { startAutoUpdateWatch } from "../features/sandbox/overview/version/autoUpdateWatch";
import { startBrowserTab } from "./browser-tab/browserTab";
import { startBrowserAgents } from "./browserAgents";

// The signed-in session's live daemon connection and the panels it feeds, mounted above every route
// (App.vue) rather than inside the workspace shell, so /setup, an invite link, and the desktop handoff
// keep it too. Presence and the background loader ride the same lifetime; floating notices live in App.vue.

// THE POPPABLE PANELS ARRIVE ONLY WHERE THEY ARE DRAWN. The chat, terminal and preview panels, xterm with its WebGL
// addon among them (~0.9 MB of JS), were imported with this runtime, so a phone downloaded, parsed and evaluated them at
// every start although its shell never mounts them. A desktop fetches the chunk the moment the runtime renders; a phone
// only if it opens a floating window.
const PoppablePanels = defineAsyncComponent(() => loadChunk(() => import(`./window/PoppablePanels.vue`)));

const liveness = useSandboxLiveness();
const route = useRoute();
const { mobile } = useDevice();

// What this tab is looking at, pushed to the daemon so other members see it live.
watch(
    () => route.name,
    (name) =>
        reportView(
            name === `extension` ? `ext:${String(route.params[`ext`])}/${String(route.params[`key`])}` : typeof name === `string` ? name : undefined,
        ),
    { immediate: true },
);
const { active: activeConversation } = useChat();
watch(
    () => activeConversation.value.session.value?.id,
    (sessionId) => reportSessionId(sessionId),
    { immediate: true },
);
// Per window, not per tab (onScreen.ts): a floating chat needs its own idle signal.
watch(onScreen, (looking) => reportIdle(!looking), { immediate: true });
// A window left on screen that nobody has touched for minutes: what lets the sandbox tell the editor left open overnight
// from a person at it, before restarting itself for an update.
watch(awayFromWindow, (away) => reportAway(away), { immediate: true });

// The one fact about the owner that only the browser holds: which clock they are on. Offered as soon as a sandbox is
// attached rather than from the settings screen, because the schedule that gets this wrong is usually created before
// anybody opens settings. Take-if-empty at the daemon, so a second window or a second member changes nothing.
onMounted(() => void offerTimezone());

// One long-lived stream keeps `reachable` live for the session, detecting a killed sandbox from anywhere.
onMounted(() => liveness.start());
onUnmounted(() => liveness.stop());

// Same lifetime as liveness: reads ahead for screens not yet open, so it can't be tied to any one of them.
onMounted(() => startBackgroundLoader());
onUnmounted(() => stopBackgroundLoader());

// Reports a landing's commit message being drafted; the walk-away happens off the Changes panel itself.
startDraftingReceipts();

// Follows the runs that end in this sandbox being replaced, for the same reason: the restart reaches the reader
// wherever they are, so what explains it cannot live on the card that started it.
startRestartWatch();

// A sandbox updating itself at a quiet moment counts down where the reader is, so they can stop it, and the silence of
// its restart is named as one, like a restart they asked for.
startAutoUpdateWatch();

// The browser tab tells what needs the reader, what finished while they were away and whether work is under way, in
// its title, its icon and (when they asked for it) a sound. Same lifetime: it is about the session, not a screen.
startBrowserTab();

// The browser view tells an agent at work in its window from one that is done by the agent's own turn, which the board
// knows and the view can't import; handed across here.
startBrowserAgents();
</script>

<template>
<!-- Mobile docks neither panel normally — chat is its own route, the terminal its own tab — but a floating window is always the exception. -->
    <PoppablePanels v-if="!mobile || floatingWindowPanel !== undefined" />
</template>
