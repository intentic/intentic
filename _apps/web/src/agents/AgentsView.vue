<script setup lang="ts">
import { useDevice } from "@intentic-app/ui";
import { onMounted, onUnmounted, ref } from "vue";
import { useRouter } from "vue-router";
import type { AgentSummary } from "@intentic/sandbox-contract";
import { useAgents } from "../composables/agents/useAgents";
import { useChat } from "../composables/chat/useChat";
import AgentCard from "./AgentCard.vue";

/* The fleet: every registered agent (isolated conversation) as a card grid — status, activity, cost at a
 * glance, attention-first ordering. Registry-driven (agents started on other devices appear too), refreshed
 * live over /events. Tapping a card drills into /agents/:id; on desktop that also focuses the docked chat. */

const router = useRouter();
const { mobile } = useDevice();
const { fleet, attention, refresh, open } = useAgents();
const { newChat, active } = useChat();

// One shared ticker for every card's elapsed readout.
const now = ref(Date.now());
let ticker: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
    void refresh();
    ticker = setInterval(() => (now.value = Date.now()), 1000);
});
onUnmounted(() => clearInterval(ticker));

const openAgent = (agent: AgentSummary): void => {
    open(agent);
    void router.push(`/agents/${encodeURIComponent(agent.id)}`);
};

// "Start an agent": a fresh isolated conversation — on mobile straight into its full-screen chat, on desktop
// the docked chat composer is focused and ready.
const startAgent = (): void => {
    newChat();
    if (mobile.value) {
        void router.push(`/agents/${encodeURIComponent(active.value.conversationId)}`);
    }
};
</script>

<template>
    <div class="flex h-full min-h-0 flex-col">
        <div class="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
            <span class="text-sm font-semibold text-content">Agents</span>
            <span v-if="attention > 0" class="rounded-full bg-primary-600/15 px-1.5 py-px text-2xs font-semibold text-link">
                {{ attention }} need{{ attention === 1 ? "s" : "" }} you
            </span>
            <span class="flex-1"></span>
            <button
                type="button"
                class="inline-flex items-center gap-1 rounded-md bg-primary-600 px-2.5 py-1 text-2xs font-medium text-white transition-colors hover:bg-primary-600/85"
                @click="startAgent"
            >
                <Icon name="plus" class="text-2xs" />New agent
            </button>
        </div>

        <div class="scrollbar-thin min-h-0 flex-1 overflow-auto p-3">
            <div v-if="fleet.length === 0" class="flex h-full flex-col items-center justify-center gap-3 text-center">
                <Icon name="sparkles" class="text-3xl text-subtle" />
                <p class="max-w-sm text-xs text-muted">
                    No agents yet. Each agent works on its own isolated branch — run several in parallel, review each one's diff, and land the
                    work you want.
                </p>
                <button
                    type="button"
                    class="rounded-md bg-primary-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-primary-600/85"
                    @click="startAgent"
                >
                    Start an agent
                </button>
            </div>
            <div v-else class="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                <AgentCard v-for="agent in fleet" :key="agent.id" :agent="agent" :now="now" @open="openAgent(agent)" />
            </div>
        </div>
    </div>
</template>
