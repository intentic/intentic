<script setup lang="ts">
import { cmp, useDevice } from "@intentic-app/ui";
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useRouter } from "vue-router";
import { dropActionLabel, dropRejection } from "../composables/agents/laneDrop";
import { useAgentDrag } from "../composables/agents/useAgentDrag";
import { type FleetAgent, type FleetLane, useAgents } from "../composables/agents/useAgents";
import { useChat } from "../composables/chat/useChat";
import AgentCard from "./AgentCard.vue";

/* The fleet as a kanban: Attention | Active | Finished — attention leftmost because the board's whole job is
 * routing the user to agents that need them. Lanes are pure projections of the registry status machine
 * (laneOf), so "finished" is automatic: the auto-land flow flips a cleanly-completed turn to landed/idle
 * within ms and the card glides over — a follow-up message glides it back. Cards animate with per-lane
 * TransitionGroups: FLIP reorder within a lane, scale-fade across lanes. Desktop = three columns; mobile =
 * the same lanes stacked (columns don't fit a phone).
 *
 * Cards drag between lanes, but because the lanes are projections a drop can't assign a status — it runs the
 * action that causes one (laneDrop): onto Finished stops a running turn or lands a conflicted one, and the
 * drop zone that appears mid-drag discards outright. Targets with no action behind them dim and explain why
 * on the drag hint instead of silently bouncing the card. */

const router = useRouter();
const { mobile } = useDevice();
const { lanes, attention, refresh, open } = useAgents();
const { newChat, active } = useChat();
const { dragged, dragging, draggedId, over, action, accepts, busyId, error, ghostStyle, begin, consumeSuppressedOpen, dismissError } = useAgentDrag();

// A lane's drop affordance, as ONE class string per state — two ring widths or two min-heights in the same
// list would resolve by Tailwind's emit order rather than by intent. The min-height only exists mid-drag, to
// give an empty lane something to aim at.
const laneDropClass = (lane: FleetLane): string => {
    if (!dragging.value) {
        return ``;
    }
    if (!accepts(lane)) {
        return `min-h-24 opacity-40`;
    }
    return over.value === lane ? `min-h-24 bg-primary-600/5 ring-2 ring-primary-500/60` : `min-h-24 ring-1 ring-line-strong/60`;
};

// What the ghost promises while it's over a target: the action's verb, or the reason there isn't one.
const hint = computed(() => {
    if (action.value !== undefined) {
        return dropActionLabel(action.value);
    }
    if (dragged.value === undefined || over.value === undefined) {
        return `Drop on a lane to act`;
    }
    return dropRejection(dragged.value, over.value);
});

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

// Card click FOCUSES, it does not navigate: on desktop it only points the docked chat (the ONE chat surface)
// at this agent and highlights the card — cheap and reversible, so the user can click down a lane to skim.
// The view-change to the review detail is a deliberate, separate act (reviewAgent, below). Mobile has no dock,
// so a tap there IS the way into the conversation — it navigates.
const focusAgent = (agent: FleetAgent): void => {
    // A drag's pointerup arrives here as a click on the card it started from; it must not also open the agent.
    if (consumeSuppressedOpen()) {
        return;
    }
    open(agent);
    if (mobile.value) {
        void router.push(`/agents/${encodeURIComponent(agent.id)}`);
    }
};

// The deliberate view-change: focus the dock AND swap the surface to the agent's review detail. Fired by the
// card's contextual affordance or its double-click accelerator (never a plain click); the card only offers it
// for a registered agent, so there is always a detail to land on.
const reviewAgent = (agent: FleetAgent): void => {
    open(agent);
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
        <div class="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
            <span class="text-sm font-semibold text-content">Agents</span>
            <span v-if="attention > 0" class="rounded-full bg-warning/15 px-1.5 py-px text-2xs font-semibold text-warning">
                {{ attention }} need{{ attention === 1 ? "s" : "" }} you
            </span>
            <span class="flex-1"></span>
            <button type="button" :class="cmp.buttonPrimary('gap-1 px-2.5 py-1 text-2xs')" @click="startAgent">
                <Icon name="plus" class="text-2xs" />New agent
            </button>
        </div>

        <!-- A drop's action failed (or landed with conflicts) — the board has no toast, so it reports in place. -->
        <p v-if="error !== undefined" class="flex shrink-0 items-center gap-2 border-b border-line bg-danger/10 px-3 py-1.5 text-2xs text-danger">
            <Icon name="exclamation-triangle" class="shrink-0 text-2xs" />
            <span class="min-w-0 flex-1">{{ error }}</span>
            <button type="button" aria-label="Dismiss" class="shrink-0 rounded p-0.5 hover:bg-danger/15" @click="dismissError">
                <Icon name="times" class="text-2xs" />
            </button>
        </p>

        <div v-if="total === 0" class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-4 text-center">
            <Icon name="sparkles" class="text-3xl text-subtle" />
            <p class="max-w-sm text-xs text-muted">
                No agents yet. Each agent works on its own isolated branch — run several in parallel and their finished work lands in your workspace
                automatically.
            </p>
            <button type="button" :class="cmp.buttonPrimary()" @click="startAgent">Start an agent</button>
        </div>

        <div v-else class="scrollbar-thin min-h-0 flex-1 overflow-auto p-3">
            <div class="grid h-full gap-3" :class="mobile ? '' : 'grid-cols-3 items-start'">
                <section
                    v-for="lane in LANES"
                    :key="lane.key"
                    :data-drop="lane.key"
                    class="flex min-w-0 flex-col rounded-xl bg-canvas/60 transition-colors"
                    :class="[!dragging && !mobile ? 'min-h-0' : '', laneDropClass(lane.key)]"
                >
                    <header class="flex items-center gap-2 px-3 py-2">
                        <span class="h-2 w-2 rounded-full" :class="lane.dot"></span>
                        <span class="text-2xs font-semibold uppercase tracking-wide text-muted">{{ lane.label }}</span>
                        <span class="rounded-full bg-overlay px-1.5 py-px text-2xs text-muted">{{ lanes[lane.key].length }}</span>
                    </header>
                    <p v-if="lanes[lane.key].length === 0" class="px-3 pb-3 text-2xs text-subtle">{{ lane.empty }}</p>
                    <TransitionGroup v-else tag="div" name="lane" class="relative flex flex-col gap-2 px-2 pb-2">
                        <AgentCard
                            v-for="agent in lanes[lane.key]"
                            :key="agent.id"
                            :agent="agent"
                            :now="now"
                            :dragging="draggedId === agent.id && dragging"
                            :busy="busyId === agent.id"
                            :selected="!mobile && active.conversationId === agent.id"
                            @open="focusAgent(agent)"
                            @review="reviewAgent(agent)"
                            @grab="(event, card) => begin(event, agent, card)"
                        />
                    </TransitionGroup>
                </section>
            </div>
        </div>

        <!-- Discard is destructive and has no lane of its own, so it only exists while a card is in flight. -->
        <div
            v-if="dragging"
            data-drop="discard"
            class="fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-1.5 rounded-full border px-4 py-2 text-2xs font-medium transition-colors"
            :class="
                over === 'discard' && action !== undefined
                    ? 'border-danger bg-danger/15 text-danger'
                    : accepts('discard')
                      ? 'border-line-strong bg-card text-muted'
                      : 'border-line bg-card text-subtle opacity-40'
            "
        >
            <Icon name="trash" class="text-2xs" />Discard
        </div>

        <!-- The ghost is a real card so the drag reads as the card itself; pointer-events-none keeps the hit
             test underneath it. -->
        <div v-if="dragging && dragged !== undefined" class="pointer-events-none fixed left-0 top-0 z-50 rotate-2" :style="ghostStyle">
            <div class="opacity-90 shadow-lg">
                <AgentCard :agent="dragged" :now="now" />
            </div>
            <p
                class="mt-1 inline-block rounded px-2 py-1 text-2xs font-medium"
                :class="action !== undefined ? 'bg-primary-fill text-fill-content' : 'bg-overlay text-subtle'"
            >
                {{ hint }}
            </p>
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
