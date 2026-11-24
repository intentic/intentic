<script setup lang="ts">
import { localPath } from "@intentic/sandbox-contract/app-routes";
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { localHost } from "../../app/environments/localHost";
import { computerAgents } from "../../client/sandbox/useDaemonRoutes";
import { useSandbox } from "../../client/sandbox/useSandbox";
import ChatPanel from "../../features/chat/panel/ChatPanel.vue";
import { readComputerHarnesses } from "../../models/conversations/accounts/computerSignIn";
import { composeAgent } from "../../models/fleet/agentActions";
import { chatFullSlot, publishSlot } from "../../workbench/window/panelSlots";
import { arrivingDraft, withoutDraft } from "./agentDraft";
import { useFollowComputerRuns } from "./followRuns";
import LocalAgentList from "./LocalAgentList.vue";
import LocalAgentsConsent from "./LocalAgentsConsent.vue";

/* AGENTS ON THIS COMPUTER (2026-11-24): this folder's conversations and the chat, in a desktop window with no sandbox
   behind it. The harness is the reader's own (Claude Code, Codex), run in the window's folder by the app's sidecar
   (_devices/host-agents), which serves each turn as the sandbox contract's own; so the chat drawn here IS the sandbox's
   chat (features/chat), with everything only a sandbox has left out where the sidecar's hello names no route for it.

   Until the reader has turned agents on for this computer, the page is one screen saying what that means
   (LocalAgentsConsent.vue): nothing here contains the agent, and the sidecar starts no turn before the yes. */

const route = useRoute();
const router = useRouter();
const host = localHost().agents;
const { reachable } = useSandbox();

onMounted(() => void host?.follow());
const accepted = computed(() => host?.accepted.value === true);

// A window whose sidecar serves folders alone has no such page: once its hello has said so, back to the folder.
watch(
    () => reachable.value && !computerAgents.value,
    (absent) => {
        if (absent) {
            void router.replace(localPath(`files`));
        }
    },
    { immediate: true },
);

// The chat stands in the page's whole right side, as a window of its own would hold it: wide enough for two chats side
// by side, which the panel decides by this slot being published (chatPanelLayout.ts `chatWide`).
const chatHome = ref<HTMLElement | null>(null);
publishSlot(chatFullSlot, () => chatHome.value);

// A FIRST MESSAGE HANDED IN ON THE ADDRESS (`?draft=`), unsent: by a press in this window, or by the shell for a draft
// the app held for this folder (appHeldDraft.ts). It is put in a blank conversation's composer and stays the reader's to
// send; nothing is sent for them, and nothing is taken before the reader has turned agents on.
const takeDraft = (): void => {
    const draft = arrivingDraft(route.query);
    if (draft === undefined || !accepted.value) {
        return;
    }
    void router.replace({ path: route.path, query: withoutDraft(route.query), hash: route.hash });
    composeAgent(draft);
};
watch([accepted, () => route.query[`draft`]], takeDraft, { immediate: true });

// A turn the sidecar starts by itself (words that waited behind a stopped turn) is followed off the roster.
useFollowComputerRuns();

// Which coding agents this computer has, their sign-ins and their models, read once the reader has said yes: the
// sidecar starts nothing, a sign-in included, before that.
watch(
    accepted,
    (on) => {
        if (on) {
            void readComputerHarnesses();
        }
    },
    { immediate: true },
);
</script>

<template>
    <LocalAgentsConsent v-if="!accepted" :host="host" />
    <div v-else-if="computerAgents" class="grid h-full min-h-0 grid-cols-[minmax(13rem,17rem)_minmax(0,1fr)]">
        <LocalAgentList class="min-h-0 border-r border-line" />
        <div ref="chatHome" class="min-h-0 min-w-0">
            <ChatPanel />
        </div>
    </div>
</template>
