<script setup lang="ts">
import type { Disposable } from "@intentic/extension-api";
import { cmp, useDevice } from "@intentic-app/ui";
import Dialog from "primevue/dialog";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { startAgent } from "../composables/agents/agentActions";
import { dropActionLabel, dropRejection } from "../composables/agents/laneDrop";
import { useAgentDrag } from "../composables/agents/useAgentDrag";
import { useAgentFilter } from "../composables/agents/useAgentFilter";
import { FINISHED_WINDOW, type FleetAgent, type FleetLane, useAgents } from "../composables/agents/useAgents";
import { relativeTime } from "../composables/chat/catalog";
import { useChat } from "../composables/chat/useChat";
import { commandShortcut, registerCommand } from "../composables/commands/useCommands";
import FilterField from "../components/FilterField.vue";
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
 *   · "Clear", which archives the lane in one press
 *   · the ARCHIVE itself, which the lane header flips to in place — a separate route would be a bigger
 *     promise than a pile of retired agents deserves
 * Archiving is lossless (branch, transcript and counters all stay — see the daemon's agents/archive.ts), so
 * none of it asks for confirmation. Discard, which is not, keeps its drag gesture and its dialog.
 *
 * WHAT AN ARCHIVE SAYS is graded to what it did (useAgents' receipt/notice split). Archiving one card says
 * nothing: the card is animated out of its lane and the header's archive counter lights up, and a strip
 * narrating that — while shoving the whole board down a line, and waiting to be dismissed — is a toll charged
 * on the most repeated action here. A SWEEP does report, because clearing twelve at once is the case with no
 * per-card animation to vouch for it, in a pill that floats over the board and retires itself. A FAILURE keeps
 * the strip, since an error is the one thing here that must be read. The way back is on the keyboard (Mod+Z)
 * and, permanently, on every card in the archive — so it never depended on the message being still on screen. */

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
    undoArchive,
    undoable,
    archivedFlash,
    notice,
    dismissNotice,
    receipt,
    dismissReceipt,
    busyIds,
    agentById,
} = useAgents();
const { active, openConversation } = useChat();
const { dragged, dragging, draggedId, over, action, accepts, busyId, ghostStyle, begin, consumeSuppressedOpen, pendingResolve, confirmResolve, cancelResolve } =
    useAgentDrag();

// The card behind the resolve confirmation — looked up live rather than snapshotted with the drop, so a
// rename or a status change while the dialog is open is reflected in what it is asking about.
const resolveTarget = computed(() => (pendingResolve.value === undefined ? undefined : agentById(pendingResolve.value)));

/* --- The filter ------------------------------------------------------------------------------------------
 * Matches what the USER wrote — the card's title (which IS their sanitized first prompt) and every later
 * prompt in that agent's transcript. Local for the tabs this browser holds, daemon-side for everything else;
 * see useAgentFilter for why the two tiers exist and why it's a factory rather than a singleton.
 *
 * The field is always on the header rather than hiding behind a glyph, so nobody has to learn that the board
 * can be searched at all. The cost is a header that WRAPS on a squeezed board — which is exactly what the
 * chat panel's drag handle produces (see NARROW_BOARD_PX below), so the bar is a .view-header-wrap and the
 * field grows into whatever room is left, the pills and New agent keeping theirs. */
const { query, needle, active: filtering, matches, snippetOf, archivedMatches, sessionMatches, searching } = useAgentFilter();
const filterField = ref<InstanceType<typeof FilterField> | undefined>(undefined);

// The Finished lane's two extra states. Both live here rather than in the store: they are how this ONE board
// is being looked at, and a second surface opening the fleet should not inherit a scroll-position-like choice.
const showAllFinished = ref(false);
const archiveOpen = ref(false);

// The results that are OFF the board — expanded by the footer row below the lanes. Collapsed by default so a
// query answers with the board first and its outskirts second; reset whenever the query changes, since "show
// me the rest" was said about a set that no longer exists.
const showBeyond = ref(false);
watch(needle, () => (showBeyond.value = false));

// The lane's visible cards. Finished shows its window (or the archive, when open); the other two lanes are
// self-emptying and show everything.
//
// A FILTER lifts the Finished window: that cap exists to keep a browsing list short (and to keep the
// TransitionGroup off several hundred cards), and a result set is neither — hiding four of a query's six hits
// behind "6 earlier" would be the board deciding which of the user's own matches they meant.
const cardsFor = (lane: FleetLane): FleetAgent[] => {
    const source =
        lane !== `finished`
            ? lanes.value[lane]
            : archiveOpen.value
              ? archived.value
              : filtering.value || showAllFinished.value
                ? lanes.value.finished
                : lanes.value.finished.slice(0, FINISHED_WINDOW);
    return filtering.value ? source.filter(matches) : source;
};

// How many of the lane's agents the filter kept, against how many it holds — the `3 of 12` on its header. The
// denominator is the lane, not the window: while filtering the window is lifted anyway, and a count that
// disagreed with the cards under it would be worse than none.
const laneCount = (lane: FleetLane): string => {
    const total = archiveOpen.value && lane === `finished` ? archived.value.length : lanes.value[lane].length;
    return filtering.value ? `${cardsFor(lane).length} of ${total}` : `${total}`;
};

const hiddenFinished = computed(() => Math.max(0, lanes.value.finished.length - FINISHED_WINDOW));

// What a query found that the board isn't showing: agents in the archive, and conversations no agent owns
// (a plain chat, or one whose registry entry is long gone). Without this the filter would answer "nothing"
// for something sitting one click away, which is the failure a search is least forgiven for.
const beyondCount = computed(() => archivedMatches.value.length + sessionMatches.value.length);
// Suppressed while the archive is the Finished column: those cards are already on screen there.
const beyondVisible = computed(() => filtering.value && !archiveOpen.value && beyondCount.value > 0);
const beyondLabel = computed(() => {
    const parts: string[] = [];
    if (archivedMatches.value.length > 0) {
        parts.push(`${archivedMatches.value.length} in the archive`);
    }
    if (sessionMatches.value.length > 0) {
        parts.push(`${sessionMatches.value.length} in earlier chats`);
    }
    return parts.join(` · `);
});

// A never-carded conversation opens as an ordinary tab — the same route the History menu's rows take.
const openSession = (id: string): void => {
    void openConversation(id);
};

const toggleArchive = (): void => {
    archiveOpen.value = !archiveOpen.value;
    if (archiveOpen.value) {
        void loadArchived();
    }
};

/* --- Saying that an archive happened -------------------------------------------------------------------- */

// The receipt retires itself: an archive is not something the user has to acknowledge, and one more thing to
// dismiss is precisely what made the strip it replaces feel like a toll. The window restarts on each new
// receipt and PAUSES while the pointer is on the pill — vanishing under the cursor that came for its Undo
// would fail the affordance at the only moment it is ever wanted. Timing lives here rather than in the store
// so the fleet module stays a plain state container (and its unit tests stay timer-free).
const RECEIPT_MS = 7_000;
const receiptHovered = ref(false);
let receiptTimer: ReturnType<typeof setTimeout> | undefined;
watch([receipt, receiptHovered], () => {
    clearTimeout(receiptTimer);
    if (receipt.value !== undefined && !receiptHovered.value) {
        receiptTimer = setTimeout(dismissReceipt, RECEIPT_MS);
    }
});

// The ambient half of the report, and the whole of it for a single card: the archive counter is where the
// cards went, so it is what acknowledges them. Long enough to catch the eye that was following the card out
// of the lane, short enough that it reads as "that just moved" rather than as a new state.
const PULSE_MS = 1_100;
const pulsing = ref(false);
let pulseTimer: ReturnType<typeof setTimeout> | undefined;
watch(archivedFlash, () => {
    pulsing.value = true;
    clearTimeout(pulseTimer);
    pulseTimer = setTimeout(() => (pulsing.value = false), PULSE_MS);
});

// A lit-up counter is nothing a screen reader can convey, so the quiet archive would be silent FULL STOP for
// one. Every archive is announced here instead — including the sweeps, so the pill can stay a purely visual
// affordance and there is exactly one thing doing the announcing.
const announcement = ref(``);
watch(archivedFlash, () => {
    announcement.value = `${undoable.value.length} agent${undoable.value.length === 1 ? `` : `s`} archived`;
});

// Undo also lives on the keyboard, because an archive that says nothing has to be reversible by the reflex
// people already have. Registered with the board and disposed with it, so the chord is only claimed while the
// fleet is on screen; the `when` gate hands it straight back whenever it would be the wrong Mod+Z — nothing
// archived to put back, or a caret sitting in a field that owns its own undo (the docked chat's composer is
// one column away from this board).
const editable = (target: EventTarget | null): boolean =>
    target instanceof HTMLElement && (target.isContentEditable || target.tagName === `INPUT` || target.tagName === `TEXTAREA`);
const undoShortcut = computed(() => commandShortcut(`agents.undoArchive`));
let boardCommands: readonly Disposable[] = [];

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
    boardCommands = [
        registerCommand({
            owner: `builtin`,
            command: `agents.undoArchive`,
            title: `Undo Archive`,
            icon: `history`,
            keybinding: `Mod+Z`,
            when: (event) => undoable.value.length > 0 && !editable(event.target),
            handler: undoArchive,
        }),
        // The field is on the header already, so this is an accelerator rather than the way in. Focus AND
        // select, so a chord pressed with a stale query in the box starts a new one by typing (VS Code's find
        // flow). Claimed only while the board is mounted — Mod+F outside it is still the browser's own find —
        // and rebindable in Settings → Keybindings like every other command here.
        registerCommand({
            owner: `builtin`,
            command: `agents.filter`,
            title: `Filter Agents…`,
            icon: `search`,
            keybinding: `Mod+F`,
            handler: () => filterField.value?.focus(),
        }),
    ];
});
onUnmounted(() => {
    clearInterval(ticker);
    clearTimeout(receiptTimer);
    clearTimeout(pulseTimer);
    boardObserver?.disconnect();
    for (const disposable of boardCommands) {
        disposable.dispose();
    }
    boardCommands = [];
    // The receipt is the board's, not the app's: leaving it set would float it over whatever surface the user
    // came back to the board from.
    dismissReceipt();
});

const LANES: readonly { key: FleetLane; label: string; dot: string; empty: string }[] = [
    { key: `attention`, label: `Attention`, dot: `bg-warning`, empty: `Nothing needs you right now.` },
    { key: `active`, label: `Active`, dot: `bg-success`, empty: `No agents working. Start one and delegate.` },
    { key: `finished`, label: `Finished`, dot: `bg-line-strong`, empty: `Finished agents land their work in your workspace.` },
];

const total = computed(() => LANES.reduce((sum, lane) => sum + lanes.value[lane.key].length, 0));

// The header's tally. Summed over the same cardsFor the lanes render, so it can never disagree with the
// `n of m` counts under it.
const kept = computed(() => LANES.reduce((sum, lane) => sum + cardsFor(lane.key).length, 0));
const matchTally = computed(() => `${kept.value} of ${total.value}`);

// Nothing on the board AND nothing beyond it — the filter's own empty state, which is a different thing from
// an empty fleet (there ARE agents; none of them is this one).
const noMatches = computed(() => filtering.value && !archiveOpen.value && kept.value === 0 && beyondCount.value === 0);

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

// A FILTERED board is a result set wearing the lanes' shape, so it does not drag. Half the lanes may be
// reading "no matches", the archive's own matches sit in a group with no lane at all, and a card dropped onto
// a lane that is currently a lens would be acted on for a reason the user never sees. The gesture comes
// straight back when the query is cleared — nothing about the board's state changed, only how it is being
// looked at.
const grabCard = (event: PointerEvent, agent: FleetAgent, card: HTMLElement): void => {
    if (filtering.value) {
        return;
    }
    begin(event, agent, card);
};
</script>

<template>
    <!-- `relative` positions the receipt inside the BOARD rather than the viewport, so the pill clears the
         mobile tab bar and the docked terminal without either of them having to be measured. It is not a
         containing block for the fixed drag ghost — only transforms and containment would be. -->
    <div ref="boardEl" class="relative flex h-full min-h-0 flex-col">
        <!-- The bar WRAPS rather than shaving its contents: the filter field is permanent, and /agents lives in
             the shell's middle column, which the chat panel's drag handle squeezes to a few hundred pixels
             while the window stays wide. Given the choice between three shrunken controls on one line and the
             field dropping to a full-width second row, the row wins — a 90px search box is not a search box.
             The field is the only thing that grows; the pills and New agent keep their size. -->
        <div class="view-header view-header-wrap flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line px-3 py-1">
            <span class="shrink-0 text-sm font-semibold text-content">Agents</span>
            <!-- Two different facts, two different pills: "needs you" is BLOCKED work (an approval, a question,
                 a conflict, an error) and earns the warning colour; "unread" is only "you haven't looked yet"
                 and stays informational — with its own way out, so silencing the board never means clicking
                 through every card. -->
            <span v-if="blocking > 0" class="shrink-0 rounded-full bg-warning/15 px-1.5 py-px text-2xs font-semibold text-warning">
                {{ blocking }} need{{ blocking === 1 ? "s" : "" }} you
            </span>
            <button
                v-if="unread > 0"
                type="button"
                aria-label="Mark all agents read"
                v-tooltip.bottom="'Mark all read'"
                class="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary-600/15 px-1.5 py-px text-2xs font-semibold text-link transition-colors hover:bg-primary-600/25"
                @click="markAllSeen"
            >
                <Icon name="check" class="text-2xs" />{{ unread }} unread
            </button>
            <FilterField
                ref="filterField"
                v-model="query"
                :busy="searching"
                label="Filter agents by your messages"
                placeholder="Filter by your messages…"
                class="min-w-32 flex-1 basis-40"
            />
            <!-- The tally, so an empty board under a query reads as "nothing matched" rather than as a board
                 that broke. Only while filtering: the lane headers already carry the unfiltered counts. -->
            <span v-if="filtering" class="shrink-0 text-2xs text-muted">{{ matchTally }}</span>
            <button type="button" :class="cmp.buttonPrimary('shrink-0 gap-1 px-2.5 py-1 text-2xs')" @click="startAgent">
                <Icon name="plus" class="text-2xs" />New agent
            </button>
        </div>

        <!-- Failures only. This strip costs a layout shift and a dismissal, which is the right price for
             something the user must read and the wrong one for a routine action's receipt — that floats
             instead, at the bottom of the board. -->
        <p v-if="notice !== undefined" class="flex shrink-0 items-center gap-2 border-b border-line bg-danger/10 px-3 py-1.5 text-2xs text-danger">
            <Icon name="exclamation-triangle" class="shrink-0 text-2xs" />
            <span class="min-w-0 flex-1">{{ notice }}</span>
            <button type="button" aria-label="Dismiss" class="shrink-0 rounded p-0.5 hover:bg-overlay" @click="dismissNotice">
                <Icon name="times" class="text-2xs" />
            </button>
        </p>

        <!-- What the counter's pulse cannot tell a screen reader. Covers every archive, quiet or not, so the
             pill below stays purely visual and nothing is announced twice. -->
        <span class="sr-only" aria-live="polite">{{ announcement }}</span>

        <!-- Nothing on the board AND nothing archived is the only true empty state. With an archive behind it,
             the same screen would otherwise be a dead end: every agent the user ever ran, and no door to it. -->
        <div v-if="total === 0 && !archiveOpen" class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-4 text-center">
            <Icon name="sparkles" class="text-3xl text-subtle" />
            <p class="max-w-sm text-xs text-muted">
                No agents yet. Each agent works on its own isolated branch — run several in parallel and their finished work lands in your workspace
                automatically.
            </p>
            <button type="button" :class="cmp.buttonPrimary()" @click="startAgent">Start an agent</button>
            <!-- Clearing the last lane lands the user here, so the empty state carries the pulse too — it is
                 the only archive affordance left on screen once the board is bare. -->
            <button
                v-if="archived.length > 0"
                type="button"
                class="inline-flex items-center gap-1 rounded px-1 py-px text-2xs text-link transition-colors hover:underline"
                :class="pulsing ? 'bg-primary-600/25 ring-1 ring-primary-500/50' : ''"
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
                            <span class="rounded-full bg-overlay px-1.5 py-px text-2xs text-muted">{{ laneCount("finished") }}</span>
                            <Icon v-if="archiveLoading" name="spinner" spin class="text-2xs text-muted" />
                        </template>
                        <template v-else>
                            <span class="h-2 w-2 rounded-full" :class="lane.dot"></span>
                            <span class="text-2xs font-semibold uppercase tracking-wide text-muted">{{ lane.label }}</span>
                            <!-- `3 of 12` while filtering: WHICH LANE a match sits in is half the answer ("still
                                 running" vs "already finished"), so the lanes stay and say how much of
                                 themselves is on screen rather than silently shrinking. -->
                            <span class="rounded-full bg-overlay px-1.5 py-px text-2xs text-muted">{{ laneCount(lane.key) }}</span>
                        </template>
                        <span class="flex-1"></span>
                        <template v-if="lane.key === 'finished' && !archiveOpen">
                            <!-- The receipt for a quiet archive: the counter is where the card went, so it is
                                 what acknowledges it — a highlight that fades, in the place the user would
                                 already look to get it back. Its tooltip is where the reassurance the old
                                 strip repeated on every press now lives, read once and on demand. -->
                            <button
                                v-if="archived.length > 0"
                                type="button"
                                :aria-label="`Open the archive (${archived.length})`"
                                v-tooltip.bottom="'Agents taken off the board. Their branches and conversations are kept.'"
                                class="inline-flex shrink-0 items-center gap-1 rounded px-1 py-px text-2xs transition-colors"
                                :class="
                                    pulsing
                                        ? 'bg-primary-600/25 text-link ring-1 ring-primary-500/50'
                                        : 'text-muted hover:bg-overlay hover:text-content'
                                "
                                @click="toggleArchive"
                            >
                                <Icon name="history" class="text-2xs" />{{ archived.length }}
                            </button>
                            <!-- Gone while filtering, for the reason the drag is (grabCard): "Clear" archives
                                 the WHOLE lane, and offering it above a lane showing "1 of 12" is offering a
                                 bulk action whose scope is not the one on screen. -->
                            <button
                                v-if="clearable > 0 && !filtering"
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
                    <!-- An emptied lane keeps its header and says so on one line. It does NOT disappear: three
                         columns collapsing to one as the query lands makes the whole board jump under the
                         cursor mid-keystroke, and the lane you were about to read moves out from under it. -->
                    <p v-else-if="cardsFor(lane.key).length === 0" class="px-3 pb-3 text-2xs text-subtle">
                        {{ filtering ? "No matches in this lane." : lane.empty }}
                    </p>
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
                            :match="snippetOf(agent)"
                            :query="needle"
                            @open="focusAgent(agent)"
                            @review="reviewAgent(agent)"
                            @archive="archive([agent.id])"
                            @restore="restore([agent.id])"
                            @grab="(event, card) => grabCard(event, agent, card)"
                        />
                    </TransitionGroup>
                    <!-- The lane's tail, not a pager: the count is the point ("there are 12 more"), and the row
                         is what keeps them one press away instead of gone. Gone while filtering — the window is
                         lifted there (see cardsFor), so there is nothing behind it to offer. -->
                    <button
                        v-if="lane.key === 'finished' && !archiveOpen && !filtering && hiddenFinished > 0"
                        type="button"
                        class="mx-2 mb-2 inline-flex items-center justify-center gap-1 rounded-lg border border-dashed border-line py-1.5 text-2xs text-muted transition-colors hover:border-line-strong hover:text-content"
                        @click="showAllFinished = !showAllFinished"
                    >
                        <Icon :name="showAllFinished ? 'chevron-up' : 'chevron-down'" class="text-2xs" />
                        {{ showAllFinished ? "Show fewer" : `${hiddenFinished} earlier` }}
                    </button>
                </section>
            </div>

            <!-- WHAT THE QUERY FOUND OFF THE BOARD. The board hides by design — the Finished lane windows to a
                 handful and archived agents leave the roster entirely — so a filter confined to the lanes would
                 answer "no matches" for an agent sitting one click away, and the user only has to catch that
                 once to stop believing the field. One row reports the count; expanding it puts the archive's
                 hits on real cards (restore and all) and the never-carded conversations on history rows.
                 Collapsed by default, and re-collapsed on every new query: the board is the answer, this is
                 its footnote. -->
            <div v-if="beyondVisible" class="border-t border-line px-3 pb-3 pt-2">
                <button
                    type="button"
                    class="flex w-full items-center gap-2 rounded-lg px-1 py-1 text-2xs text-muted transition-colors hover:text-content"
                    :aria-expanded="showBeyond"
                    @click="showBeyond = !showBeyond"
                >
                    <Icon name="search" class="shrink-0 text-2xs text-subtle" />
                    <span class="min-w-0 flex-1 truncate text-left">{{ beyondLabel }}</span>
                    <span class="shrink-0 font-medium text-link">{{ showBeyond ? "Hide" : "Show" }}</span>
                    <Icon :name="showBeyond ? 'chevron-up' : 'chevron-down'" class="shrink-0 text-2xs" />
                </button>

                <div v-if="showBeyond" class="mt-2 flex flex-col gap-3">
                    <section v-if="archivedMatches.length > 0" class="flex min-w-0 flex-col gap-2">
                        <div class="flex items-center gap-2 px-1">
                            <Icon name="box" class="shrink-0 text-2xs text-subtle" />
                            <span class="text-2xs font-semibold uppercase tracking-wide text-muted">In the archive</span>
                            <span class="rounded-full bg-overlay px-1.5 py-px text-2xs text-muted">{{ archivedMatches.length }}</span>
                        </div>
                        <!-- Real cards, not a stripped-down list: an archived agent keeps its branch, its diff
                             and its transcript, so the thing the user wants to do with a hit here — read it,
                             restore it — is exactly what the card already offers. -->
                        <div class="grid gap-2" :class="narrow ? '' : 'grid-cols-3 items-start'">
                            <AgentCard
                                v-for="agent in archivedMatches"
                                :key="agent.id"
                                :agent="agent"
                                :now="now"
                                :dense="narrow"
                                :busy="busyIds.includes(agent.id)"
                                :selected="!mobile && active.conversationId === agent.id"
                                :match="snippetOf(agent)"
                                :query="needle"
                                @open="focusAgent(agent)"
                                @review="reviewAgent(agent)"
                                @restore="restore([agent.id])"
                            />
                        </div>
                    </section>

                    <section v-if="sessionMatches.length > 0" class="flex min-w-0 flex-col gap-1">
                        <div class="flex items-center gap-2 px-1">
                            <Icon name="history" class="shrink-0 text-2xs text-subtle" />
                            <span class="text-2xs font-semibold uppercase tracking-wide text-muted">In earlier chats</span>
                            <span class="rounded-full bg-overlay px-1.5 py-px text-2xs text-muted">{{ sessionMatches.length }}</span>
                        </div>
                        <!-- Conversations no agent entry owns — a plain chat, or one whose entry is long gone.
                             There is no card to draw for them, so they read as history rows and open as tabs,
                             the same act the History menu performs. -->
                        <button
                            v-for="session in sessionMatches"
                            :key="session.id"
                            type="button"
                            class="flex flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-overlay"
                            @click="openSession(session.id)"
                        >
                            <span class="truncate text-xs text-content">{{ session.title }}</span>
                            <span v-if="session.snippet !== undefined" class="line-clamp-2 text-2xs italic text-muted">{{ session.snippet }}</span>
                            <span class="text-2xs text-subtle">{{ relativeTime(session.updatedAt) }}</span>
                        </button>
                    </section>
                </div>
            </div>

            <!-- The filter's own empty state, which is NOT the empty board's: there are agents, just none of
                 them this one. Says what was searched, so a typo is visible without looking back up at the
                 field, and names the rule — the commonest reason for a miss is searching for something the
                 AGENT said rather than something you did. -->
            <p v-if="noMatches" class="px-4 pb-6 text-center text-2xs text-subtle">
                No agent of yours mentions “{{ query.trim() }}”. This searches the messages you wrote — not the agents' replies.
            </p>
        </div>

        <!-- The sweep's receipt. It OVERLAYS the board rather than sitting in the column, so the cards it is
             reporting on don't move to make room for the report — and it expires, so acknowledging it is not
             work. Hidden mid-drag: the discard target lands in the same place, and one of them is destructive.
             The wrapper is inert; only the pill takes the pointer, or it would eat clicks on the lane under it. -->
        <Transition name="receipt">
            <div v-if="receipt !== undefined && !dragging" class="pointer-events-none absolute inset-x-0 bottom-4 z-30 flex justify-center px-3">
                <div
                    class="pointer-events-auto flex max-w-full items-center gap-2 rounded-full border border-line-strong bg-card py-1.5 pl-3 pr-2 text-2xs text-muted shadow-lg"
                    @mouseenter="receiptHovered = true"
                    @mouseleave="receiptHovered = false"
                >
                    <Icon name="box" class="shrink-0 text-2xs" />
                    <span class="min-w-0 truncate">{{ receipt.message }}</span>
                    <button
                        v-if="receipt.undo !== undefined"
                        type="button"
                        class="shrink-0 rounded-full px-2 py-px font-semibold text-link transition-colors hover:bg-primary-600/15"
                        v-tooltip.top="undoShortcut === undefined ? 'Put them back on the board' : `Put them back on the board (${undoShortcut})`"
                        @click="receipt.undo"
                    >
                        Undo
                    </button>
                </div>
            </div>
        </Transition>

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

        <!-- Dropping a conflicted card on Finished spends a turn, and a drag is the easiest gesture on this
             board to make by accident — so unlike stop / land / discard it stops here first. The dialog is the
             whole explanation of what the agent is about to do, because the drag hint that got here is four
             words long. -->
        <Dialog
            :visible="pendingResolve !== undefined"
            :modal="true"
            :draggable="false"
            :dismissable-mask="true"
            :style="{ width: '26rem' }"
            header="Have the agent resolve the conflict?"
            @update:visible="cancelResolve"
        >
            <p class="text-xs text-content">
                {{ resolveTarget?.title ?? `This agent` }} will start a turn: it rebases its branch onto your current workspace, resolves the conflict
                in its own worktree, and lands the result when it's done.
            </p>
            <p class="mt-2 text-xs text-muted">Nothing is written to your workspace unless it succeeds. You can stop the turn at any point.</p>
            <template #footer>
                <button type="button" class="rounded px-3 py-1 text-xs text-muted hover:text-content" @click="cancelResolve">Cancel</button>
                <button type="button" :class="cmp.buttonPrimary('rounded px-3 py-1')" @click="confirmResolve">Ask the agent</button>
            </template>
        </Dialog>

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

/* The receipt rises into place and sinks out of it — the same direction both ways, so a pill that expires on
 * its own and one dismissed by an Undo read as the same object leaving. */
.receipt-enter-active,
.receipt-leave-active {
    transition:
        transform 200ms ease,
        opacity 200ms ease;
}
.receipt-enter-from,
.receipt-leave-to {
    opacity: 0;
    transform: translateY(0.5rem);
}
</style>
