<script setup lang="ts">
import { localPath } from "@intentic/sandbox-contract/app-routes";
import { computed, onMounted, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { localHost } from "../../app/environments/localHost";
import { computerAgents } from "../../client/sandbox/useDaemonRoutes";
import { useSandbox } from "../../client/sandbox/useSandbox";
import Agents from "../../features/agents/fleet/Agents.vue";
import { composeAgent } from "../../models/fleet/agentActions";
import { arrivingDraft, withoutDraft } from "./agentDraft";
import LocalAgentsConsent from "./LocalAgentsConsent.vue";

/* AGENTS ON THIS COMPUTER (2026-11-24): this folder's conversations, in a desktop window with no sandbox behind it. The
   harness is the reader's own (Claude Code, Codex), run in the window's folder by the app's sidecar
   (_devices/host-agents), which serves each turn and each card as the sandbox contract's own; so the page drawn here IS
   a sandbox's Agents page (features/agents/fleet/Agents.vue), the board with its lanes and its filter, and the chat
   stands beside it in the shell's right-hand column as it does in a sandbox (LocalChat.vue). Everything only a sandbox
   has (landing, forks, usage left, the night) is left out where the sidecar's hello names no route for it. Until
   2026-11-25 the page was a list of its own beside a chat that filled the window, and nothing here read like a sandbox's.

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
</script>

<template>
    <LocalAgentsConsent v-if="!accepted" :host="host" />
    <Agents v-else-if="computerAgents" />
</template>
