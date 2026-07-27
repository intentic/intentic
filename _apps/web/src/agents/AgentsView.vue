<script setup lang="ts">
import { cmp, useDevice } from "@intentic-app/ui";
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useRouter } from "vue-router";
import { startAgent } from "../composables/agents/agentActions";
import { dropActionLabel, dropRejection } from "../composables/agents/laneDrop";
import { useAgentDrag } from "../composables/agents/useAgentDrag";
import { FINISHED_WINDOW, type FleetAgent, type FleetLane, useAgents } from "../composables/agents/useAgents";
import { useChat } from "../composables/chat/useChat";
import AgentCard from "./AgentCard.vue";

/* The fleet as a kanban: Attention | Active | Finished — attention leftmost because the board's whole job is
 * routing the user to agents that need them. Lanes are pure projections of the registry status machine
 * (laneOf), so "finished" is automatic: the auto-land flow flips a cleanly-completed turn to landed/idle
 * within ms and the card glides over — a follow-up message glides it back. Cards animate with per-lane
 * TransitionGroups: FLIP reorder within a lane, scale-fade across lanes. A wide board is three columns; a
 * narrow one stacks the same lanes down the page (see below).
 *
 * Cards drag between lanes, but because the lanes are projections a drop can't assign a status — it runs the
 * action that causes one (laneDrop): onto Finished stops a running turn or lands a conflicted one, and the
 * drop zone that appears mid-drag discards outright. Targets with no action behind them dim and explain why
 * on the drag hint instead of silently bouncing the card.
 *
 * The board is sized by its OWN width, not the viewport's: /agents lives in the shell's middle column, which
 * the chat panel's drag handle squeezes to a few hundred pixels while the window stays wide — a case `mobile`
 * never sees. Below NARROW_BOARD_PX three columns can only be bought by shredding every card (a 190px card
 * truncates its title to "Ne…" and its branch to "agent/7…"), so the lanes stack instead and the cards take
 * the full width in their row form. The lanes, their order, their counts and their drop targets are identical
 * either way — the board is the same board, laid out down the page rather than across it.
 *
 * FINISHED is the one lane with no way out of its own — nothing transitions off landed/idle — so it needs the
 * three affordances the other two get for free from the status machine:
 *   · a WINDOW (FINISHED_WINDOW), because the lane's job is confirming what just completed, not holding the
 *     sandbox's whole history; everything older collapses behind one row rather than being hidden
 *   · "Clear", which archives the lane in one press, undoable from the notice strip
 *   · the ARCHIVE itself, which the lane header flips to in place — a separate route would be a bigger
 *     promise than a pile of retired agents deserves
 * Archiving is lossless (branch, transcript and counters all stay — see the daemon's agents/archive.ts), so
 * none of it asks for confirmation. Discard, which is not, keeps its drag gesture and its dialog. */

const router = useRouter();
const { mobile } = useDevice();
const {
    lanes,
    blocking,
    unread,
    refresh,
    open,
    markAllSeen,
    archived,
    archiveLoading,
    loadArchived,
    archive,
    restore,
    notice,
    dismissNotice,
    busyIds,
} = useAgents();
const { active } = useChat();
const { dragged, dragging, draggedId, over, action, accepts, busyId, ghostStyle, begin, consumeSuppressedOpen } = useAgentDrag();

// The Finished lane's two extra states. Both live here rather than in the store: they are how this ONE board
// is being looked at, and a second surface opening the fleet should not inherit a scroll-position-like choice.
const showAllFinished = ref(false);
const archiveOpen = ref(false);

// The lane's visible cards. Finished shows its window (or the archive, when open); the other two lanes are
// self-emptying and show everything.
const cardsFor = (lane: FleetLane): FleetAgent[] => {
    if (lane !== `finished`) {
        return lanes.value[lane];
    }
    if (archiveOpen.value) {
        return archived.value;
    }
    return showAllFinished.value ? lanes.value.finished : lanes.value.finished.slice(0, FINISHED_WINDOW);
};

const hiddenFinished = computed(() => Math.max(0, lanes.value.finished.length - FINISHED_WINDOW));

const toggleArchive = (): void => {
    archiveOpen.value = !archiveOpen.value;
    if (archiveOpen.value) {
        void loadArchived();
    }
};

// A lane's drop affordance, as ONE class string per state — two ring widths or two min-heights in the same
// list would resolve by Tailwind's emit order rather than by intent. The min-height only exists mid-drag, to
// give an empty lane something to aim at.
const laneDropClass = (lane: FleetLane): string => {
    if (!dragging.value) {
        return ``;
    }
    // While the archive occupies the Finished column it isn't a lane — it has no `data-drop`, so it must not
    // advertise one either.
    if (!accepts(lane) || (lane === `finished` && archiveOpen.value)) {
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

// Three columns need ~270px each before a card starts truncating its title — below that the board stacks.
// Measured off the board element rather than declared as a CSS container query, because `container-type`
// makes an element a containing block for its fixed-position descendants, and the drag ghost is fixed at
// viewport coordinates.
const NARROW_BOARD_PX = 840;
const boardEl = ref<HTMLElement | undefined>(undefined);
// Unmeasured reads as wide: the ResizeObserver's first callback lands before the first paint, so the fallback
// is never seen, and defaulting the other way would flash three columns on a phone.
const boardWidth = ref(Number.POSITIVE_INFINITY);
const narrow = computed(() => boardWidth.value < NARROW_BOARD_PX);

// One shared ticker for every card's elapsed/time-ago readout.
const now = ref(Date.now());
let ticker: ReturnType<typeof setInterval> | undefined;
let boardObserver: ResizeObserver | undefined;
onMounted(() => {
    void refresh();
    if (boardEl.value !== undefined) {
        boardObserver = new ResizeObserver(([entry]) => (boardWidth.value = entry?.contentRect.width ?? boardWidth.value));
        boardObserver.observe(boardEl.value);
    }
    // The archive is off the live roster, so its size has to be asked for. Worth the one request at mount:
    // without a count the Finished header can only offer an archive the user has no reason to believe holds
    // anything, and an empty board would hide every agent they ever ran behind an unlabelled button.
    void loadArchived();
    ticker = setInterval(() => (now.value = Date.now()), 1000);
});
onUnmounted(() => {
    clearInterval(ticker);
    boardObserver?.disconnect();
});

const LANES: readonly { key: FleetLane; label: string; dot: string; empty: string }[] = [
    { key: `attention`, label: `Attention`, dot: `bg-warning`, empty: `Nothing needs you right now.` },
    { key: `active`, label: `Active`, dot: `bg-success`, empty: `No agents working. Start one and delegate.` },
    { key: `finished`, label: `Finished`, dot: `bg-line-strong`, empty: `Finished agents land their work in your workspace.` },
];

const total = computed(() => LANES.reduce((sum, lane) => sum + lanes.value[lane.key].length, 0));

// "Clear" only appears when it would do something — the Finished lane holds the archivable set exactly (it is
// landed-or-idle by construction), so its length is the answer.
const clearable = computed(() => lanes.value.finished.length);

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
</script>

<template>
    <div ref="boardEl" class="flex h-full min-h-0 flex-col">
        <div class="view-header flex items-center gap-2 border-b border-line px-3">
            <span class="text-sm font-semibold text-content">Agents</span>
            <!-- Two different facts, two different pills: "needs you" is BLOCKED work (an approval, a question,
                 a conflict, an error) and earns the warning colour; "unread" is only "you haven't looked yet"
                 and stays informational — with its own way out, so silencing the board never means clicking
                 through every card. -->
            <span v-if="blocking > 0" class="rounded-full bg-warning/15 px-1.5 py-px text-2xs font-semibold text-warning">
                {{ blocking }} need{{ blocking === 1 ? "s" : "" }} you
            </span>
            <button
                v-if="unread > 0"
                type="button"
                aria-label="Mark all agents read"
                v-tooltip.bottom="'Mark all read'"
                class="inline-flex items-center gap-1 rounded-full bg-primary-600/15 px-1.5 py-px text-2xs font-semibold text-link transition-colors hover:bg-primary-600/25"
                @click="markAllSeen"
            >
                <Icon name="check" class="text-2xs" />{{ unread }} unread
            </button>
            <span class="flex-1"></span>
            <button type="button" :class="cmp.buttonPrimary('gap-1 px-2.5 py-1 text-2xs')" @click="startAgent">
                <Icon name="plus" class="text-2xs" />New agent
            </button>
        </div>

        <!-- The board has no toast, so both things it ever has to say land here: an action that failed (a drop,
             an archive) and an action that succeeded but should be reversible. The Undo is the whole reason a
             bulk archive needs no confirmation up front — the cheaper apology, rather than the dialog. -->
        <p
            v-if="notice !== undefined"
            class="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5 text-2xs"
            :class="notice.tone === 'error' ? 'bg-danger/10 text-danger' : 'bg-overlay text-muted'"
        >
            <Icon :name="notice.tone === 'error' ? 'exclamation-triangle' : 'box'" class="shrink-0 text-2xs" />
            <span class="min-w-0 flex-1">{{ notice.message }}</span>
            <button
                v-if="notice.undo !== undefined"
                type="button"
                class="shrink-0 rounded px-1.5 py-px font-semibold text-link transition-colors hover:bg-primary-600/15"
                @click="notice.undo"
            >
                Undo
            </button>
            <button type="button" aria-label="Dismiss" class="shrink-0 rounded p-0.5 hover:bg-overlay" @click="dismissNotice">
                <Icon name="times" class="text-2xs" />
            </button>
        </p>

        <!-- Nothing on the board AND nothing archived is the only true empty state. With an archive behind it,
             the same screen would otherwise be a dead end: every agent the user ever ran, and no door to it. -->
        <div v-if="total === 0 && !archiveOpen" class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-4 text-center">
            <Icon name="sparkles" class="text-3xl text-subtle" />
            <p class="max-w-sm text-xs text-muted">
                No agents yet. Each agent works on its own isolated branch — run several in parallel and their finished work lands in your workspace
                automatically.
            </p>
            <button type="button" :class="cmp.buttonPrimary()" @click="startAgent">Start an agent</button>
            <button
                v-if="archived.length > 0"
                type="button"
                class="inline-flex items-center gap-1 text-2xs text-link transition-colors hover:underline"
                @click="toggleArchive"
            >
                <Icon name="history" class="text-2xs" />{{ archived.length }} archived agent{{ archived.length === 1 ? "" : "s" }}
            </button>
        </div>

        <!-- The scroller carries no padding of its own: the stacked board's lane headers pin to `top-0`, and a
             padded scrollport would leave a strip above them for the cards to scroll through. -->
        <div v-else class="scrollbar-thin min-h-0 flex-1 overflow-auto">
            <!-- Stacked, the lanes are rows of one grid that is still `h-full` (so a lane keeps a drop target
                 when the board is empty) — `content-start` is what stops those rows from stretching to fill it
                 and leaving a lane's cards floating a hundred pixels above the next header. -->
            <div class="grid h-full gap-3 p-3" :class="narrow ? 'content-start' : 'grid-cols-3 items-start'">
                <section
                    v-for="lane in LANES"
                    :key="lane.key"
                    :data-drop="lane.key === 'finished' && archiveOpen ? undefined : lane.key"
                    class="flex min-w-0 flex-col rounded-xl bg-canvas/60 transition-colors"
                    :class="[!dragging && !narrow ? 'min-h-0' : '', laneDropClass(lane.key)]"
                >
                    <!-- The Finished lane doubles as the archive's window, so its header is the one that
                         changes: in archive mode it swaps its dot and label and grows a way back.
                         Stacked, the header also becomes the lane's marker while you scroll: three lanes down
                         one page is a page and a half of cards, and a card is only readable as "finished" if
                         the lane it belongs to is still on screen. It pins inside its own section, so it
                         leaves with it rather than sitting over the next lane's cards. -->
                    <header class="flex items-center gap-2 px-3 py-2" :class="narrow ? 'sticky top-0 z-10 rounded-t-xl bg-canvas' : ''">
                        <template v-if="lane.key === 'finished' && archiveOpen">
                            <button
                                type="button"
                                aria-label="Back to finished agents"
                                v-tooltip.bottom="'Back to finished'"
                                class="flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted transition-colors hover:bg-overlay hover:text-content"
                                @click="toggleArchive"
                            >
                                <Icon name="arrow-left" class="text-2xs" />
                            </button>
                            <span class="text-2xs font-semibold uppercase tracking-wide text-muted">Archived</span>
                            <span class="rounded-full bg-overlay px-1.5 py-px text-2xs text-muted">{{ archived.length }}</span>
                            <Icon v-if="archiveLoading" name="spinner" spin class="text-2xs text-muted" />
                        </template>
                        <template v-else>
                            <span class="h-2 w-2 rounded-full" :class="lane.dot"></span>
                            <span class="text-2xs font-semibold uppercase tracking-wide text-muted">{{ lane.label }}</span>
                            <span class="rounded-full bg-overlay px-1.5 py-px text-2xs text-muted">{{ lanes[lane.key].length }}</span>
                        </template>
                        <span class="flex-1"></span>
                        <template v-if="lane.key === 'finished' && !archiveOpen">
                            <button
                                v-if="archived.length > 0"
                                type="button"
                                :aria-label="`Open the archive (${archived.length})`"
                                v-tooltip.bottom="'Agents taken off the board. Their branches and conversations are kept.'"
                                class="inline-flex shrink-0 items-center gap-1 rounded px-1 py-px text-2xs text-muted transition-colors hover:bg-overlay hover:text-content"
                                @click="toggleArchive"
                            >
                                <Icon name="history" class="text-2xs" />{{ archived.length }}
                            </button>
                            <button
                                v-if="clearable > 0"
                                type="button"
                                aria-label="Archive every finished agent"
                                v-tooltip.bottom="`Archive all ${clearable} — nothing is lost, and you can undo it`"
                                class="shrink-0 rounded px-1 py-px text-2xs text-muted transition-colors hover:bg-overlay hover:text-content"
                                @click="archive()"
                            >
                                Clear
                            </button>
                        </template>
                    </header>
                    <p v-if="lane.key === 'finished' && archiveOpen && archived.length === 0" class="px-3 pb-3 text-2xs text-subtle">
                        Nothing archived yet. Finished agents land here on their own after a few quiet days.
                    </p>
                    <p v-else-if="cardsFor(lane.key).length === 0" class="px-3 pb-3 text-2xs text-subtle">{{ lane.empty }}</p>
                    <TransitionGroup v-else tag="div" name="lane" class="relative flex flex-col gap-2 px-2 pb-2">
                        <AgentCard
                            v-for="agent in cardsFor(lane.key)"
                            :key="agent.id"
                            :agent="agent"
                            :now="now"
                            :dense="narrow"
                            :dragging="draggedId === agent.id && dragging"
                            :busy="busyId === agent.id || busyIds.includes(agent.id)"
                            :selected="!mobile && active.conversationId === agent.id"
                            @open="focusAgent(agent)"
                            @review="reviewAgent(agent)"
                            @archive="archive([agent.id])"
                            @restore="restore([agent.id])"
                            @grab="(event, card) => begin(event, agent, card)"
                        />
                    </TransitionGroup>
                    <!-- The lane's tail, not a pager: the count is the point ("there are 12 more"), and the row
                         is what keeps them one press away instead of gone. -->
                    <button
                        v-if="lane.key === 'finished' && !archiveOpen && hiddenFinished > 0"
                        type="button"
                        class="mx-2 mb-2 inline-flex items-center justify-center gap-1 rounded-lg border border-dashed border-line py-1.5 text-2xs text-muted transition-colors hover:border-line-strong hover:text-content"
                        @click="showAllFinished = !showAllFinished"
                    >
                        <Icon :name="showAllFinished ? 'chevron-up' : 'chevron-down'" class="text-2xs" />
                        {{ showAllFinished ? "Show fewer" : `${hiddenFinished} earlier` }}
                    </button>
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
                <AgentCard :agent="dragged" :now="now" :dense="narrow" />
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
