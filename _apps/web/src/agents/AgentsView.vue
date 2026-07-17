<script setup lang="ts">
import { useDevice } from "@intentic-app/ui";
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useRouter } from "vue-router";
import { type FleetAgent, type FleetLane, useAgents } from "../composables/agents/useAgents";
import { useChat } from "../composables/chat/useChat";
import AgentCard from "./AgentCard.vue";

/* The fleet as a kanban: Attention | Active | Finished — attention leftmost because the board's whole job is
 * routing the user to agents that need them. Lanes are pure projections of the registry status machine
 * (laneOf), so "finished" is automatic: the auto-land flow flips a cleanly-completed turn to landed/idle
 * within ms and the card glides over — a follow-up message glides it back. Cards animate with per-lane
 * TransitionGroups: FLIP reorder within a lane, scale-fade across lanes. Desktop = three columns; mobile =
 * the same lanes stacked (columns don't fit a phone). */

const router = useRouter();
const { mobile } = useDevice();
const { lanes, attention, refresh, open } = useAgents();
const { newChat, active } = useChat();

// One shared ticker for every card's elapsed/time-ago readout.
const now = ref(Date.now());
let ticker: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
    void refresh();
    ticker = setInterval(() => (now.value = Date.now()), 1000);
});
onUnmounted(() => clearInterval(ticker));

const LANES: readonly { key: FleetLane; label: string; dot: string; empty: string }[] = [
    { key: `attention`, label: `Attention`, dot: `bg-warning`, empty: `Nothing needs you right now.` },
    { key: `active`, label: `Active`, dot: `bg-success`, empty: `No agents working. Start one and delegate.` },
    { key: `finished`, label: `Finished`, dot: `bg-line-strong`, empty: `Finished agents land their work in your workspace.` },
];

const total = computed(() => LANES.reduce((sum, lane) => sum + lanes.value[lane.key].length, 0));

// Card click: focus the conversation in the docked chat (the ONE desktop chat surface) and — when there is
// something to review — open the review detail. A draft has no worktree/diff yet, so on desktop its click
// only focuses the dock; on mobile the detail IS the chat, so every card navigates.
const openAgent = (agent: FleetAgent): void => {
    open(agent);
    if (!mobile.value && agent.status === `draft`) {
        return;
    }
    void router.push(`/agents/${encodeURIComponent(agent.id)}`);
};

// "New agent": a fresh isolated conversation. On desktop the board stays put — the draft card appears in
// Active and the docked composer focuses; on mobile there is no dock, so go straight into the chat.
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
            <span v-if="attention > 0" class="rounded-full bg-warning/15 px-1.5 py-px text-2xs font-semibold text-warning">
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

        <div v-if="total === 0" class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-4 text-center">
            <Icon name="sparkles" class="text-3xl text-subtle" />
            <p class="max-w-sm text-xs text-muted">
                No agents yet. Each agent works on its own isolated branch — run several in parallel and their finished work lands in your
                workspace automatically.
            </p>
            <button
                type="button"
                class="rounded-md bg-primary-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-primary-600/85"
                @click="startAgent"
            >
                Start an agent
            </button>
        </div>

        <div v-else class="scrollbar-thin min-h-0 flex-1 overflow-auto p-3">
            <div class="grid h-full gap-3" :class="mobile ? '' : 'grid-cols-3 items-start'">
                <section v-for="lane in LANES" :key="lane.key" class="flex min-w-0 flex-col rounded-xl bg-canvas/60" :class="mobile ? '' : 'min-h-0'">
                    <header class="flex items-center gap-2 px-3 py-2">
                        <span class="h-2 w-2 rounded-full" :class="lane.dot"></span>
                        <span class="text-2xs font-semibold uppercase tracking-wide text-muted">{{ lane.label }}</span>
                        <span class="rounded-full bg-overlay px-1.5 py-px text-2xs text-muted">{{ lanes[lane.key].length }}</span>
                    </header>
                    <p v-if="lanes[lane.key].length === 0" class="px-3 pb-3 text-2xs text-subtle">{{ lane.empty }}</p>
                    <TransitionGroup v-else tag="div" name="lane" class="relative flex flex-col gap-2 px-2 pb-2">
                        <AgentCard v-for="agent in lanes[lane.key]" :key="agent.id" :agent="agent" :now="now" @open="openAgent(agent)" />
                    </TransitionGroup>
                </section>
            </div>
        </div>
    </div>
</template>

<style scoped>
/* Kanban motion: FLIP reorder within a lane (`lane-move`), scale-fade on lane entry/exit. The leaving card
 * is absolutely positioned so its siblings glide into place instead of jumping — the standard
 * TransitionGroup requirement for smooth collapse. */
.lane-move,
.lane-enter-active,
.lane-leave-active {
    transition:
        transform 250ms ease,
        opacity 200ms ease;
}
.lane-enter-from,
.lane-leave-to {
    opacity: 0;
    transform: scale(0.95);
}
.lane-leave-active {
    position: absolute;
    left: 0.5rem;
    right: 0.5rem;
}
</style>
