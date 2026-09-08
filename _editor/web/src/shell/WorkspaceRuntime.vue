<script setup lang="ts">
import { useDevice } from "@intentic/ui";
import { onMounted, onUnmounted, watch } from "vue";
import { useRoute } from "vue-router";
import { useChat } from "../features/chat/run/useChat";
import { floatingWindowPanel } from "./window/floating";
import { onScreen } from "./window/onScreen";
import { startBackgroundLoader, stopBackgroundLoader } from "../router/prefetch/useBackgroundLoader";
import { startDraftingReceipts } from "../features/workspace/changes/draftingReceipts";
import { reportIdle, reportSessionId, reportView } from "./presence/usePresence";
import { useSandboxLiveness } from "../features/sandbox/overview/useSandboxLiveness";
import PoppablePanels from "./window/PoppablePanels.vue";

// The signed-in session's live daemon connection and the panels it feeds, mounted above every route
// (App.vue) rather than inside the workspace shell, so /setup, an invite link, and the desktop handoff
// keep it too. Presence and the background loader ride the same lifetime; floating notices live in App.vue.

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

// One long-lived stream keeps `reachable` live for the session, detecting a killed sandbox from anywhere.
onMounted(() => liveness.start());
onUnmounted(() => liveness.stop());

// Same lifetime as liveness: reads ahead for screens not yet open, so it can't be tied to any one of them.
onMounted(() => startBackgroundLoader());
onUnmounted(() => stopBackgroundLoader());

// Reports a landing's commit message being drafted; the walk-away happens off the Changes panel itself.
startDraftingReceipts();
</script>

<template>
    <!--
        Mobile docks neither panel normally — chat is its own route, the terminal its own tab — but a
        floating window is always the exception: the panel is that window's entire content.
    -->
    <PoppablePanels v-if="!mobile || floatingWindowPanel !== undefined" />
</template>
