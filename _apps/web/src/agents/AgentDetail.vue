<script setup lang="ts">
import { Segmented, useDevice } from "@intentic-app/ui";
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import ChatPanel from "../chat/ChatPanel.vue";
import { useAgents } from "../composables/agents/useAgents";
import { useChat } from "../composables/chat/useChat";
import AgentReviewPanel from "./AgentReviewPanel.vue";

/* Drill-in for one agent (/agents/:id): Chat = the conversation full-screen (the shared ChatPanel, focused on
 * this agent's tab); Changes = the isolated diff + Land/Discard. On mobile this IS the chat surface (the old
 * /chat tab folded in here); on desktop the chat is docked in the shell, so the view defaults to Changes. */

const route = useRoute();
const router = useRouter();
const { mobile } = useDevice();
const { fleet, open, markSeen } = useAgents();
const { conversations, setActive } = useChat();

const agentId = computed(() => (typeof route.params[`id`] === `string` ? route.params[`id`] : ``));
const registryAgent = computed(() => fleet.value.find((agent) => agent.id === agentId.value));
const conversation = computed(() => conversations.value.find((candidate) => candidate.conversationId === agentId.value));

// Bind the shared chat singleton to this agent's tab: open/create from the registry entry, else focus the
// already-open conversation (a brand-new agent that hasn't run a turn has no registry entry yet). Neither ⇒
// nothing to show; bounce back to the fleet. Keyed on the id + the roster SIZE, not the registryAgent
// computed — its per-recompute object identity (and markSeen's write into the fleet source) would refire
// this watch forever.
watch(
    [agentId, () => fleet.value.length],
    ([id], [previousId] = [undefined, 0]) => {
        if (id === `` || (id === previousId && conversation.value !== undefined)) {
            return;
        }
        if (registryAgent.value !== undefined) {
            open(registryAgent.value);
            return;
        }
        if (conversation.value !== undefined) {
            setActive(conversation.value.id);
            markSeen(id);
            return;
        }
        void router.replace(`/agents`);
    },
    { immediate: true },
);

const view = ref<`chat` | `changes`>(mobile.value ? `chat` : `changes`);
const viewOptions: { label: string; value: `chat` | `changes` }[] = [
    { label: `Chat`, value: `chat` },
    { label: `Changes`, value: `changes` },
];

const title = computed(() => registryAgent.value?.title ?? conversation.value?.title.value ?? `Agent`);
</script>

<template>
    <div class="flex h-full min-h-0 flex-col">
        <div class="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5">
            <button
                type="button"
                class="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-overlay hover:text-content"
                @click="router.push('/agents')"
                aria-label="Back to agents"
            >
                <Icon name="arrow-left" class="text-sm" />
            </button>
            <span class="min-w-0 flex-1 truncate text-xs font-medium text-content">{{ title }}</span>
            <span v-if="registryAgent?.branch !== undefined" class="truncate font-mono text-2xs text-subtle">{{ registryAgent.branch }}</span>
            <Segmented v-model="view" :options="viewOptions" />
        </div>
        <ChatPanel v-if="view === 'chat'" class="min-h-0 flex-1" />
        <AgentReviewPanel v-else-if="agentId !== ''" :agent-id="agentId" class="min-h-0 flex-1" />
    </div>
</template>
