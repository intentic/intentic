<script setup lang="ts">
import { useDevice } from "@intentic/ui";
import { onMounted, onUnmounted, watch } from "vue";
import { useRoute } from "vue-router";
import { useChat } from "../composables/chat/useChat";
import { onScreen } from "../composables/onScreen";
import { startBackgroundLoader, stopBackgroundLoader } from "../composables/prefetch/useBackgroundLoader";
import { startDraftingReceipts } from "../composables/workspace/draftingReceipts";
import { reportIdle, reportSessionId, reportView } from "../composables/usePresence";
import { useSandboxLiveness } from "../composables/sandbox/useSandboxLiveness";
import LocalShortcutNotice from "./LocalShortcutNotice.vue";
import PoppablePanels from "./PoppablePanels.vue";
import PushNotice from "./PushNotice.vue";
import ReceiptBar from "./ReceiptBar.vue";

/* THE SIGNED-IN SESSION'S LIVE CONNECTION TO ITS SANDBOX, and the panels that connection feeds — mounted by
 * App.vue for as long as an account has a sandbox selected, and therefore ABOVE every route rather than inside
 * the workspace shell.
 *
 * It sits here because the shell is not the app. /setup (where "Add sandbox" goes), an invite link and the
 * desktop sign-in handoff are all routes outside it, and stopping the daemon stream on the way to one is what
 * made a popped-out chat go dead the moment the user clicked "Add sandbox": the panel itself now survives that
 * navigation (PoppablePanels), so the stream behind it has to survive it too — a floating window rendering a
 * disconnected chat would only be a slower way to lose the conversation.
 *
 * Presence rides the same lifetime, as it always has: it is this tab's claim about what its user is looking at,
 * which is as true on /setup as it is in the workspace, and it is only deliverable while the stream it is
 * reported over is open. So does the push notice, for the third variation of the same reason: the question it
 * asks outlives the view that asked for the push. */

const liveness = useSandboxLiveness();
const route = useRoute();
const { mobile } = useDevice();

// Presence reporting: what this tab is looking at, pushed to the daemon so other members see it live.
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
// Idle is "nobody is looking", asked of every window this tab renders into rather than of the tab itself
// (composables/onScreen.ts): a user typing in a popped-out chat while the tab sits behind another one was
// reported away to everyone else, in the window where they were most obviously present.
watch(onScreen, (looking) => reportIdle(!looking), { immediate: true });

// One long-lived SSE stream to the daemon keeps `reachable` live for the whole session, so a killed sandbox is
// detected the moment the stream breaks — wherever in the app the user happens to be standing.
onMounted(() => liveness.start());
onUnmounted(() => liveness.stop());

// …and, on the same lifetime and for the same reason, the background loader: it reads ahead for screens the
// user has not reached yet, so tying it to any one of them would mean it only ever warmed the screen already
// open. It gates itself on the stream's verdict and on whether anyone is looking (composables/prefetch).
onMounted(() => startBackgroundLoader());
onUnmounted(() => stopBackgroundLoader());

/* …and the report that a landing's commit message is being written, for the third variation of the reason the
 * notice and the receipt host are up here: the seconds it takes are spent walking away from the board that
 * landed it, so a report tied to the Changes panel would only ever reach someone already standing in front of
 * the answer. */
startDraftingReceipts();
</script>

<template>
    <!-- The mobile shell docks neither panel — its chat is the agent route and its terminal a tab of its own —
         so there is nothing out there to own, and nothing that could be popped into a window. -->
    <PoppablePanels v-if="!mobile" />
    <!-- A push that needs an answer, asked wherever the user has got to. It belongs to the session for the same
         reason the stream does: the check that raises it takes minutes, the user was told to go and do something
         else, and every route in the app is somewhere they might reasonably be when it lands. -->
    <PushNotice />
    <!-- The app's quiet channel: what just happened, retiring itself. One host above the router, for the same
         reason the notice above has one — a completion reported from a dialog, a tree row or a settings card is
         the same event to the user and must not depend on which view raised it. It is deliberately NOT cleared
         on navigation: "3 files deleted" is still true on the next screen, and it is gone in seconds anyway. -->
    <ReceiptBar />
    <!-- The offer to reach this sandbox over the loopback shortcut, asked before the browser's own permission
         dialog can ask it worse. Up here because the stream is: the probe that raises it runs on every connect,
         and a connect happens on /setup and behind an invite link as readily as in the workspace. -->
    <LocalShortcutNotice />
</template>
