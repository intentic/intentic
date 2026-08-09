<script setup lang="ts">
import Button from "primevue/button";
import type { Disposable } from "@intentic/extension-api";
import type { WorkflowRun } from "@intentic/sandbox-contract";
import { clipboardOf, cmp, ContextMenu, SearchBar, useDevice } from "@intentic/ui";
import Dialog from "primevue/dialog";
import type { MenuItem } from "primevue/menuitem";
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { startAgent } from "../composables/agents/agentActions";
import { markAgentStarted } from "../composables/agents/firstRun";
import { usePanels } from "../composables/extensions/usePanels";
import { useChanges } from "../composables/workspace/useChanges";
import { useSandbox } from "../composables/sandbox/useSandbox";
import { synthesizeSessions, synthesizing } from "../composables/agents/synthesizeSessions";
import { dropActionLabel, dropRejection, type PendingAction } from "../composables/agents/laneDrop";
import { useAgentDrag } from "../composables/agents/useAgentDrag";
import { useAgentFilter } from "../composables/agents/useAgentFilter";
import { type FleetLane, reviewAction, unregistered } from "../composables/agents/agentStatus";
import { canArchive, FINISHED_WINDOW, type FleetAgent, useAgents, windowFinished } from "../composables/agents/useAgents";
import { insideRun, laneOfRun, runIdsInLedger, runMatches, runsInLane, runsNeedingYou, useWorkflowRuns } from "../composables/agents/useWorkflowRuns";
import { relativeTime } from "../composables/chat/catalog";
import { chatRun, showingRunGraph } from "../composables/chat/chatRun";
import { openRunInChat } from "../composables/chat/openRun";
import { traceFocus } from "../composables/chat/focusTrace";
import { useChat } from "../composables/chat/useChat";
import { useChatPopout } from "../composables/chat/useChatPopout";
import { useNow } from "../composables/useNow";
import { commandShortcut, registerCommand } from "../composables/commands/useCommands";
import MatchLine from "../components/MatchLine.vue";
import AgentCard from "./AgentCard.vue";
import HeldWakeCard from "./HeldWakeCard.vue";
import WorkflowRunCard from "./WorkflowRunCard.vue";
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
 * THE ARCHIVE HAS AN EXIT OF ITS OWN — "Delete all", in the same header slot "Clear" occupies on the live lane,
 * because that slot is already read as this column's bulk exit. It is the board's only irreversible action, so
 * it inverts the archive's whole grammar: it confirms first, it reports even for one agent, and its receipt
 * carries no Undo (see purgeArchived in useAgents). Deliberately bulk-only — a per-card delete would put a
 * destructive button a pixel from Restore on the same hover row, and a single agent that must go for good
 * already has Discard on its review panel, where the diff it is about to lose is on screen beside it.
 *
 * WHAT AN ARCHIVE SAYS is graded to what it did (useAgents' receipt/notice split). Archiving one card says
 * nothing: the card is animated out of its lane and the header's archive counter lights up, and a strip
 * narrating that — while shoving the whole board down a line, and waiting to be dismissed — is a toll charged
 * on the most repeated action here. A SWEEP does report, because clearing twelve at once is the case with no
 * per-card animation to vouch for it, in a pill that floats over the board and retires itself. A FAILURE keeps
 * the strip, since an error is the one thing here that must be read. The way back is on the keyboard (Mod+Z)
 * and, permanently, on every card in the archive — so it never depended on the message being still on screen. */
const router = useRouter();
const route = useRoute();
const { mobile } = useDevice();
const {
    lanes,
    fleet,
    blocking,
    unread,
    heldWakes,
    releaseHeld,
    refresh,
    open,
    markAllSeen,
    archived,
    archiveLoading,
    loadArchived,
    archive,
    restore,
    purgeArchived,
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
const { active, openConversation, panes, openBeside, closePane, collapsePanes, closeTabs, setPanes } = useChat();
const { popOut: popOutChat, poppedOut } = useChatPopout();
// A refusal lands on the board's notice strip — the preparation refuses whole (a running source, a transcript
// that couldn't be captured), and a press that does nothing visible reads as a button that broke.
const synthesize = async (): Promise<void> => {
    const result = await synthesizeSessions();
    if (!result.started) {
        notice.value = result.why;
    }
};
const {
    dragged,
    dragging,
    draggedId,
    over,
    action,
    accepts,
    busy,
    ghostStyle,
    begin,
    consumeSuppressedOpen,
    pendingResolve,
    confirmResolve,
    cancelResolve,
    resolveNow,
    landNow,
    relandNow,
} = useAgentDrag();
// The card behind the resolve confirmation — looked up live rather than snapshotted with the drop, so a
// rename or a status change while the dialog is open is reflected in what it is asking about.
const resolveTarget = computed(() => (pendingResolve.value === undefined ? undefined : agentById(pendingResolve.value)));
/* WHAT A CARD IS WAITING ON, from the board's two sources of it: the press or drop this browser is running
 * (useAgentDrag, which names its action so the button that fired it can spin in place) and the archive/restore
 * batches, which are addressed by id alone — an id in flight there is being filed AWAY unless it is already
 * archived, in which case the only thing anyone can be doing to it is putting it back. */
const pendingFor = (agent: FleetAgent): PendingAction | undefined => {
    if (busy.value?.id === agent.id) {
        return busy.value.action;
    }
    if (!busyIds.value.includes(agent.id)) {
        return undefined;
    }
    return agent.archivedAt !== undefined ? `restore` : `archive`;
};
/* --- The filter ------------------------------------------------------------------------------------------
 * Matches what the USER wrote — the card's title (which IS their sanitized first prompt) and every later
 * prompt in that agent's transcript. Local for the tabs this browser holds, daemon-side for everything else;
 * see useAgentFilter for why the two tiers exist and why it's a factory rather than a singleton.
 *
 * The field is always on the header rather than hiding behind a glyph, so nobody has to learn that the board
 * can be searched at all. The cost is a header that WRAPS on a squeezed board — which is exactly what the
 * chat panel's drag handle produces (see NARROW_BOARD_PX below), so the bar is a .view-header-wrap. The field
 * keeps a useful, capped width on a roomy board and wraps rather than being crushed when the board narrows. */
const { query, needle, active: filtering, matches, snippetOf, archivedMatches, sessionMatches, searching } = useAgentFilter();
const filterField = ref<InstanceType<typeof SearchBar> | undefined>(undefined);
// The Finished lane's two extra states. Both live here rather than in the store: they are how this ONE board
// is being looked at, and a second surface opening the fleet should not inherit a scroll-position-like choice.
const showAllFinished = ref(false);
const archiveOpen = ref(false);
// The Finished window is only in force while the lane is BROWSING its own recent tail. The archive is a
// different list entirely, and both a filter and an explicit expand lift the cap outright — see cardsFor.
const windowed = computed(() => !archiveOpen.value && !filtering.value && !showAllFinished.value);

const { runs: workflowRuns, stop: stopWorkflowRun, archive: archiveWorkflowRun, unarchive: unarchiveWorkflowRun } = useWorkflowRuns();
// Which runs have a step waiting on the user. Read from the fleet, because "blocked" is a live fact about a
// conversation and the run ledger only knows what the scheduler wrote.
const needingYou = computed(() => runsNeedingYou(fleet.value));
// A run under a query answers for its steps, since they no longer have cards to answer with (runMatches).
const runKept = (run: WorkflowRun): boolean => !filtering.value || runMatches(run, needle.value, fleet.value, matches);
// The two halves of the ledger, on the board's own terms: an archived run is off the board exactly as an
// archived agent is, and the Finished lane's archive view is where it turns up instead. Each half is kept in
// both its forms because the counts need them — a `n of m` whose denominator was itself filtered says nothing.
const boardRunRows = computed(() => workflowRuns.value.filter((run) => run.archivedAt === undefined));
const liveRuns = computed(() => boardRunRows.value.filter(runKept));
const archivedRunRows = computed(() => workflowRuns.value.filter((run) => run.archivedAt !== undefined));
const archivedRuns = computed(() => archivedRunRows.value.filter(runKept));
const runsFor = (lane: FleetLane): WorkflowRun[] => {
    // The archive is a different list wearing the Finished lane's shape: the runs in it are the archived ones,
    // and the other two lanes have nothing to say while it is open.
    if (archiveOpen.value) {
        return lane === `finished` ? archivedRuns.value : [];
    }
    // The window caps Finished while it is being browsed and is lifted by a filter or the lane's own expand —
    // the agents' rule, and it has to be the runs' too now that a capped run takes its steps into hiding.
    return runsInLane(liveRuns.value, lane, windowed.value ? FINISHED_WINDOW : Number.POSITIVE_INFINITY, needingYou.value);
};

/* THE STEPS OF A RUN ARE NOT ALSO CARDS — they are inside the run's row, which is the whole claim that row
 * makes. A five-step workflow was arriving as a run card AND five agent cards for the same work, so the board
 * reported one job six times and the run's own row was the least informative of them.
 *
 * Gated on the LEDGER rather than on the run being drawn (insideRun says why at length): every reason a row
 * was not on screen — a filter, the Finished window, the archive being open — used to release that run's
 * conversations onto the board as loose cards.
 */
const BOARD_LANES = [`attention`, `active`, `finished`] as const;
const ledgerRunIds = computed(() => runIdsInLedger(workflowRuns.value));
const boardLanes = computed<Record<FleetLane, FleetAgent[]>>(() => {
    if (ledgerRunIds.value.size === 0) {
        return lanes.value;
    }
    const outside = (agent: FleetAgent): boolean => !insideRun(agent, ledgerRunIds.value);
    return {
        attention: lanes.value.attention.filter(outside),
        active: lanes.value.active.filter(outside),
        finished: lanes.value.finished.filter(outside),
    };
});
// The archive obeys the same rule, and needs to: a run's steps are filed away WITH it, so without this the
// pile the archive shows would be one run row and the five conversations it already stands for.
const archivedCards = computed(() => archived.value.filter((agent) => !insideRun(agent, ledgerRunIds.value)));
// How big the archive READS — the rows it would draw, which is what the door promising to open it and the
// header counting it are both about. A run filed away with its four steps is one row there, not five.
const archiveSize = computed(() => archivedCards.value.length + archivedRunRows.value.length);

// The run's DESIGN, on the workflows page — a different question from "what is it doing", and the only one
// this board cannot answer: editing the graph belongs where the graph is authored.
// The results that are OFF the board — expanded by the footer row below the lanes. Collapsed by default so a
// query answers with the board first and its outskirts second; reset whenever the query changes, since "show
// me the rest" was said about a set that no longer exists.
const showBeyond = ref(false);
watch(needle, () => (showBeyond.value = false));
/* WHICH CARD WEARS THE RING. Normally the docked chat's agent — desktop only, since a phone has no dock for
 * "selected" to be about — and, for a moment after a link named one, that card on either form factor (the
 * focus block below sets `flashId`; it owns the timer that clears it).
 *
 * Board-wide state rather than a paint, because the ring is not the only thing that follows it: the Finished
 * window keeps this card whatever its age (windowFinished), and a selection made anywhere but this board
 * scrolls it into view (revealCard). */
const flashId = ref<string | undefined>(undefined);
/* A RUN'S DIAGRAM ON SCREEN TAKES THE RING OFF EVERY AGENT, because in that state the chat is pointing at no
 * conversation at all — it is showing the map of one. The board went on ringing whichever card had the focus
 * before the run took the panel, which reads as "that chat is what you are looking at" while the panel shows
 * something else entirely, and the run card beside it wore nothing. The run's own sessions are a different
 * case and keep the ordinary rule: those ARE conversations, and the focused one is genuinely on screen.
 *
 * The predicate is the PANEL'S OWN (showingRunGraph), not a second reading of the mode, because the mode alone
 * stopped being the answer: a run being FOLLOWED draws its diagram too, for as long as it has nothing live to
 * put in the panes. Only popped out — docked, the panel shows the focused chat whatever the run is doing. */
const runGraphUp = computed(
    () =>
        poppedOut.value &&
        showingRunGraph(
            workflowRuns.value.find((run) => run.runId === chatRun.value?.runId),
            chatRun.value,
            panes.value,
        ),
);
const highlightId = computed(() => flashId.value ?? (mobile.value || runGraphUp.value ? undefined : active.value.conversationId));
/* THE OTHER COLUMNS, ringed exactly as that one is. A split is not a ranking — the reader put two chats up to
 * read them together — so the board no longer draws the panes that don't hold the keyboard a step fainter than
 * the one that does (AgentCard.selected has the rest of it; the chat rail dropped the same second weight). The
 * two states that take the ring off the focused chat take it off these as well, which is why this is read off
 * `highlightId`'s own conditions rather than off the pane set alone. */
const inPane = (id: string): boolean => !mobile.value && !runGraphUp.value && panes.value.length > 1 && panes.value.includes(id);
const finishedWindow = computed(() => windowFinished(boardLanes.value.finished, windowed.value ? highlightId.value : undefined, (agent) => agent.id));
// The lane's visible cards. Finished shows its window (or the archive, when open); the other two lanes are
// self-emptying and show everything.
//
// A FILTER lifts the Finished window: that cap exists to keep a browsing list short (and to keep the
// TransitionGroup off several hundred cards), and a result set is neither — hiding four of a query's six hits
// behind "6 earlier" would be the board deciding which of the user's own matches they meant.
const cardsFor = (lane: FleetLane): FleetAgent[] => {
    const source =
        lane !== `finished`
            ? boardLanes.value[lane]
            : archiveOpen.value
              ? archivedCards.value
              : windowed.value
                ? finishedWindow.value.shown
                : boardLanes.value.finished;
    return filtering.value ? source.filter(matches) : source;
};
/* How many of the lane's ROWS the filter kept, against how many it holds — the `3 of 12` on its header. The
 * denominator is the lane, not the window: while filtering the window is lifted anyway, and a count that
 * disagreed with the cards under it would be worse than none.
 *
 * A run counts as the ONE row it is, on both sides, for exactly that reason: a query that a workflow answers
 * left the lane reading "0 of 3" with the run sitting under the header saying so, which is the count calling
 * the row beneath it a mistake. Its steps are not counted at all — they are inside that row.
 */
const laneCount = (lane: FleetLane): string => {
    const held =
        archiveOpen.value && lane === `finished`
            ? archiveSize.value
            : boardLanes.value[lane].length + runsInLane(boardRunRows.value, lane, Number.POSITIVE_INFINITY, needingYou.value).length;
    return filtering.value ? `${cardsFor(lane).length + runsFor(lane).length} of ${held}` : `${held}`;
};
/* What the tail row collapses: the window's own count, so a card pinned into the lane is counted out of it
 * rather than being both on screen and reported as hidden — PLUS the runs the same window capped.
 *
 * The runs have to be in this number now that a hidden run hides its steps with it. Counting only the agents
 * would leave a whole workflow behind a row that does not know it is there, which is the one thing the window
 * is not allowed to do: it caps browsing, it never closes anything.
 */
const hiddenRuns = computed(
    () => runsInLane(liveRuns.value, `finished`, Number.POSITIVE_INFINITY, needingYou.value).length - runsFor(`finished`).length,
);
const hiddenFinished = computed(() => finishedWindow.value.hidden + hiddenRuns.value);
// What a query found that the board isn't showing: agents in the archive, and conversations no agent owns
// (a plain chat, or one whose registry entry is long gone). Without this the filter would answer "nothing"
// for something sitting one click away, which is the failure a search is least forgiven for. Steps are left
// out on the board's own rule — the archived run row they belong to is what the archive lists them under.
const archivedHits = computed(() => archivedMatches.value.filter((agent) => !insideRun(agent, ledgerRunIds.value)));
const beyondCount = computed(() => archivedHits.value.length + sessionMatches.value.length);
// Suppressed while the archive is the Finished column: those cards are already on screen there.
const beyondVisible = computed(() => filtering.value && !archiveOpen.value && beyondCount.value > 0);
const beyondLabel = computed(() => {
    const parts: string[] = [];
    if (archivedHits.value.length > 0) {
        parts.push(`${archivedHits.value.length} in the archive`);
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
// What the board says to a screen reader, since neither of its two visual reports — the archive counter's
// pulse, the receipt pill — is anything one can convey. Every archive lands here (see the archivedFlash watch
// below), and so does every deletion, so there is exactly one thing doing the announcing.
const announcement = ref(``);
/* --- Emptying the archive -------------------------------------------------------------------------------
 * The board's one irreversible act, so it is the one that stops and asks. It sits in the archive header's
 * trailing slot — where the Finished lane puts "Clear" — because that slot is already read as "this column's
 * bulk exit": Finished's exit is the archive, and the archive's is deletion. Same position, opposite weight,
 * which is what the danger styling and the dialog are for.
 *
 * Only "delete everything", never per card. The archive is the pile the user has already decided is over, so
 * cleaning it up is ONE intent with one confirmation — and a per-card delete would be a destructive button
 * sitting a pixel from Restore on a hover row, which is the one place it must not be. A single agent that has
 * to go for good still goes through its review panel's Discard, where the diff it is about to lose is on
 * screen next to the button.
 *
 * The dialog names the branch count and says what survives, because the archive's whole promise up to this
 * point has been "nothing is lost" — the press that revokes it has to say so in those terms. */
const pendingPurge = ref(false);
const purging = ref(false);
// Whether THIS visit emptied the archive, which is the difference between two identical-looking empty lists:
// "nothing has been archived yet" is a promise about what will land here, and it reads as a lie to someone who
// just deleted twelve agents. Reset when the archive is left, so the wording is about what the user did while
// they were looking at it.
const purged = ref(false);
const confirmPurge = async (): Promise<void> => {
    pendingPurge.value = false;
    purging.value = true;
    const aimedAt = archived.value.length;
    try {
        await purgeArchived();
        purged.value = true;
        // The receipt this raises is visual only, like the sweep's — and this is the one report on the board
        // that cannot be re-derived from anything left on screen, because what it is about is gone.
        announcement.value = `${aimedAt - archived.value.length} archived agents deleted`;
    } finally {
        purging.value = false;
    }
};
const toggleArchive = (): void => {
    archiveOpen.value = !archiveOpen.value;
    purged.value = false;
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
// One archive, one reaction: the pulse the eye catches and the line a screen reader hears are the same event
// said two ways, so they are said in one place rather than from two watchers over the same source.
watch(archivedFlash, () => {
    pulsing.value = true;
    clearTimeout(pulseTimer);
    pulseTimer = setTimeout(() => (pulsing.value = false), PULSE_MS);
    announcement.value = `${undoable.value.length} agent${undoable.value.length === 1 ? `` : `s`} archived`;
});
/* --- THE CARD A LINK NAMED: /agents?focus=<agent id> -----------------------------------------------------
 * Another surface can hand the user an agent it just started — ext-pipelines' "Fix with agent" is the first —
 * and what that hand-off wants is the BOARD, not the drill-in: a turn that began a second ago has no diff to
 * review, and the fleet is where the user watches it work beside everything else they have running.
 *
 * The id arrives BEFORE the card does: the agent was created by the click that navigated here, so the roster
 * frame carrying it lands a beat after this board mounts. Hence a held request resolved by a watcher rather
 * than a read at mount — it fires the moment the fleet knows the agent, and simply never fires for an id the
 * fleet has no card for. Resolving is one-shot and consumes the parameter, so a reload or a Back does not
 * re-focus a card the user has since moved off.
 *
 * The focus itself is exactly what a click on the card does — the docked chat points at the agent, the card
 * takes the ring, it is marked read — plus the two things a click gets for free and a link cannot: the board
 * scrolls the card into view, and it OPENS WHATEVER IS HIDING IT first. A board hides three ways (a filter, the
 * archive, the Finished window), and a link that lands on none of the cards on screen is a link that silently
 * did nothing. Only two of the three are opened here: the window keeps the selected card by itself
 * (windowFinished), on every surface that HAS a selection to keep it by. */
const FOCUS_FLASH_MS = 4_000;
let flashTimer: ReturnType<typeof setTimeout> | undefined;
const cardEls = new Map<string, HTMLElement>();
// AgentCard is a component, so the ref hands back its instance rather than an element; `$el` is its root div.
const setCardEl = (id: string, el: unknown): void => {
    const root = (el as { $el?: unknown } | null)?.$el;
    if (root instanceof HTMLElement) {
        cardEls.set(id, root);
    } else {
        cardEls.delete(id);
    }
};
// Bring a card into the scrollport. Awaited, because the card may not be rendered on the tick it was asked
// for: the window pins it (windowFinished) and the focus flow below uncovers it, both on this one. `nearest`
// so a card already on screen is left exactly where it is rather than being yanked to an edge.
const revealCard = async (id: string): Promise<void> => {
    await nextTick();
    cardEls.get(id)?.scrollIntoView({ block: `nearest` });
};
/* A SELECTION MADE OFF THE BOARD BRINGS THE BOARD WITH IT. Clicking a chat tab, or opening a conversation from
 * History, moves the ring to a card that may be a lane and a half further down — and a ring drawn outside the
 * scrollport is indistinguishable from the board ignoring the click. A selection made ON the board scrolls
 * nothing: the card is already under the cursor that made it, so `selectedHere` marks it and this stands down. */
let selectedHere: string | undefined;
watch(highlightId, (id) => {
    // Consumed on sight, whichever way it goes: the mark is about the ONE selection the board just made, not a
    // claim about that agent forever. Left standing, a card clicked here once would never scroll again when the
    // user came back to it from the tab strip — which is the exact traffic this exists for.
    const ours = id === selectedHere;
    selectedHere = undefined;
    if (id === undefined || ours) {
        return;
    }
    void revealCard(id);
});
const requestedFocus = ref<string | undefined>(undefined);
watch(
    () => route.query[`focus`],
    (value) => {
        if (typeof value === `string` && value !== ``) {
            requestedFocus.value = value;
        }
    },
    { immediate: true },
);
watch(
    () => (requestedFocus.value === undefined ? undefined : agentById(requestedFocus.value)),
    async (agent) => {
        if (agent === undefined) {
            return;
        }
        requestedFocus.value = undefined;
        void router.replace({ query: { ...route.query, focus: undefined } });
        // Uncover the card. The filter is the user's own lens and the archive is a different list, so both have
        // to be lifted by hand. The Finished window does it on its own — but only where a ring exists to pin the
        // card by: a phone has no dock, so `highlightId` goes undefined the moment the flash expires and the
        // lane would close over the very card the link was for. There, the whole lane opens instead.
        if (filtering.value && !matches(agent)) {
            query.value = ``;
        }
        if (agent.archivedAt !== undefined) {
            archiveOpen.value = true;
        } else if (mobile.value && lanes.value.finished.findIndex((candidate) => candidate.id === agent.id) >= FINISHED_WINDOW) {
            showAllFinished.value = true;
        }
        open(agent);
        flashId.value = agent.id;
        clearTimeout(flashTimer);
        flashTimer = setTimeout(() => (flashId.value = undefined), FOCUS_FLASH_MS);
        // Explicitly, not through the selection watch above: a link may name the agent the dock is ALREADY
        // pointing at, and then the ring never moves for that watch to see.
        await revealCard(agent.id);
    },
    { immediate: true },
);
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
// The shared clock, for every card's elapsed/time-ago readout.
const now = useNow();
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
        // flow). Deliberately UNBOUND: Mod+F belongs to the browser's own find, and this registry is global to
        // every window the app owns — so a binding claimed while the board is mounted swallowed Mod+F in the
        // popped-out chat too, where the board is not even on screen and the focus went to a hidden field.
        // Bindable in Settings → Keybindings by anyone who wants it, like every other command here.
        registerCommand({
            owner: `builtin`,
            command: `agents.filter`,
            title: `Filter Agents…`,
            icon: `search`,
            // Focus AND select: the chord is pressed with whatever was last typed still in the box, and starting
            // a new query by typing beats having to clear the old one first (VS Code's find flow).
            handler: () => filterField.value?.focus(true),
        }),
    ];
});
onUnmounted(() => {
    clearTimeout(receiptTimer);
    clearTimeout(pulseTimer);
    clearTimeout(flashTimer);
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
/* The board's own total, so it counts WHAT IS ON SCREEN: a run's steps are inside its row, not beside it, so
 * they are counted once — as the row. Without the run half a board showing a workflow and nothing else read
 * "0 of 0" and then told the user their query matched nothing, with the match sitting above the sentence. */
// Held wakes count toward the board having something to show — a fresh workspace whose only row is a hold
// must not hide it behind the "No agents yet" splash.
const total = computed(
    () => LANES.reduce((sum, lane) => sum + boardLanes.value[lane.key].length, 0) + boardRunRows.value.length + heldWakes.value.length,
);
/* HAS ANYTHING EVER HAPPENED HERE — a different question from `total`, and the one the first-run screen and the
 * desktop's first landing both turn on. The docked chat always holds one conversation, and a conversation the
 * fleet has never heard of is a `draft` CARD on this board (useAgents.fleet): so a workspace where nobody has
 * done anything still counts one, `total` is never 0 on it, and both features built on that count would be dead
 * on exactly the workspace they exist for — the first-run screen never drawn, and the landing flag set by the
 * first page load rather than by the first agent.
 *
 * An untouched draft is the empty composer one column over, not work. Anything else counts, the archive
 * included: agents that ran and were filed away are a history, and this board should show a person with one the
 * ordinary lanes and the door to it rather than a pitch for a product they already use. */
const started = computed(
    () =>
        LANES.reduce((sum, lane) => sum + boardLanes.value[lane.key].filter((agent) => agent.status !== `draft`).length, 0) +
            boardRunRows.value.length +
            heldWakes.value.length +
            archiveSize.value >
        0,
);
// The header's tally. Summed over the same cardsFor and runsFor the lanes render, so it can never disagree
// with the `n of m` counts under it.
const kept = computed(() => LANES.reduce((sum, lane) => sum + cardsFor(lane.key).length + runsFor(lane.key).length, 0));
const matchTally = computed(() => `${kept.value} of ${total.value}`);
// Nothing on the board AND nothing beyond it — the filter's own empty state, which is a different thing from
// an empty fleet (there ARE agents; none of them is this one).
const noMatches = computed(() => filtering.value && !archiveOpen.value && kept.value === 0 && beyondCount.value === 0);
// "Clear" only appears when it would do something — the Finished lane holds the archivable set exactly (it is
// landed-or-idle by construction), so its length is the answer.
const clearable = computed(() => lanes.value.finished.length);

/* --- The first run --------------------------------------------------------------------------------------
 * A BARE BOARD IS THE ONE SCREEN THAT HAS TO TEACH. On a fresh workspace this is where the desktop now lands
 * (router/index.ts), straight out of setup, and what stood here was a sentence describing the board and a
 * button that opened an empty composer somewhere else — which hands the whole burden of imagination to
 * somebody who has been using the product for four seconds. So the empty state IS a composer: one question,
 * one box, and a few tasks worth pressing, which is the shape every tool that solves this problem converges on.
 *
 * A chip FILLS the box, it does not send. One rule for all of them, because they are not all complete: "bring
 * in my code" ends mid-sentence waiting for a repository, and a chip that sometimes dispatches an agent and
 * sometimes doesn't is a control nobody can predict. It also leaves the text there to be edited, which is the
 * point of suggesting it rather than doing it. */
const firstTask = ref(``);
const firstTaskField = ref<HTMLTextAreaElement | undefined>(undefined);
// The workspace facts the suggestions turn on, both already in flight for the rail — the board adds no fetch.
const { panels: workspaceRepos } = usePanels();
const workspaceChanges = useChanges();
// Whether there is anything here to work ON. Repos are the plain case; uncommitted changes cover the other one
// — files dropped into /work without a git of their own still land as changes on the workspace's own repo, and
// telling that user their workspace is empty would be the suggestion contradicting what they are looking at.
const hasWork = computed(() => workspaceRepos.value.length > 0 || workspaceChanges.count.value > 0);
/* Tasks worth a first press, phrased as the ladder the quickstarts of this product's neighbours all use:
 * understand it, then a small safe change with a stop before anything is written. Concrete sentences rather
 * than feature names — "Explain this codebase" is a thing to press; "code understanding" is a brochure. */
const starters = computed<readonly { readonly label: string; readonly prompt: string }[]>(() => {
    if (!hasWork.value) {
        return [
            // Left deliberately unfinished: the repository is the one thing only the user can supply, and a
            // chip that guessed at it would send an agent after something that does not exist.
            { label: `Bring in my code`, prompt: `Clone my repository into this workspace: ` },
            {
                label: `Start a new project`,
                prompt: `Start a new project in this workspace. Ask me what I want to build before you scaffold anything.`,
            },
        ];
    }
    return [
        // Uncommitted work is the most urgent thing on a workspace that has any, so it leads when it exists.
        ...(workspaceChanges.count.value > 0
            ? [{ label: `Review my changes`, prompt: `Review my uncommitted changes and flag anything risky before I commit them.` }]
            : []),
        {
            label: `Explain this codebase`,
            prompt: `Explain this codebase — what it does, where the entry points are, and which files I should read first.`,
        },
        {
            label: `Find something to improve`,
            prompt: `Suggest three small, safe improvements to this codebase. Wait for me to choose one before you change anything.`,
        },
    ];
});
// Fill and focus, caret at the end — an unfinished prompt has to leave the user typing where the sentence stops.
const useStarter = async (prompt: string): Promise<void> => {
    firstTask.value = prompt;
    await nextTick();
    const field = firstTaskField.value;
    field?.focus();
    field?.setSelectionRange(prompt.length, prompt.length);
};
const sendFirstTask = (): void => {
    const task = firstTask.value.trim();
    if (task.length === 0) {
        return;
    }
    firstTask.value = ``;
    startAgent(task);
};
/* AGENTS ON THE BOARD MEAN THIS IS NOT A FIRST RUN, whatever this browser's storage says — a workspace driven
 * from another machine, or from before the flag existed, has already been delegated to, and the desktop should
 * go back to opening on the workspace for it. startAgent records the same fact on the press; this is the other
 * end, for the runs it never saw. Keyed on `started`, so the docked chat's untouched draft does not record it. */
const { activeSandboxId } = useSandbox();
watch(
    started,
    (ever) => {
        if (ever) {
            markAgentStarted(activeSandboxId.value);
        }
    },
    { immediate: true },
);
// Card click FOCUSES, it does not navigate: on desktop it only points the docked chat (the ONE chat surface)
// at this agent and highlights the card — cheap and reversible, so the user can click down a lane to skim.
// The view-change to the review detail is a deliberate, separate act (reviewAgent, below). Mobile has no dock,
// so a tap there IS the way into the conversation — it navigates.
/* --- Cards into chat panes ----------------------------------------------------------------------
 * The chat rail's gestures (ChatTabList.onRowClick), on the board — because at N panes the two are the same
 * act: what is selected IS what is on screen, so a card picked here is a chat given a column there.
 *
 * ALT carries "in addition" rather than Ctrl alone, and not because Ctrl is taken: a card is a drag source
 * (lanes, land, resolve), and on macOS Ctrl+click IS the secondary click. Alt collides with neither, so the
 * one-shot verb — the one most people will reach for — is the one that can never be misread. Ctrl/Cmd and
 * Shift are there for whoever learned them on the strips.
 *
 * And a click with NO modifier is the reset (focusAgent's tail): these gestures make a selection, and a
 * selection you cannot replace by pointing somewhere else is not one — the split outlived every later click
 * and had to be dismantled a × at a time.
 *
 * The pane is claimed BEFORE `open` (see useChat.openBeside): the opening would otherwise take the focused
 * pane's column on its way in, and the chat the user was reading would vanish to make room. */
const paneOrder = computed<FleetAgent[]>(() => LANES.flatMap((lane) => cardsFor(lane.key)));
const paneAnchor = ref<string>();
const paneGesture = (agent: FleetAgent, event: MouseEvent): boolean => {
    if (event.shiftKey) {
        const order = paneOrder.value;
        const from = order.findIndex((card) => card.id === (paneAnchor.value ?? active.value.conversationId));
        const to = order.findIndex((card) => card.id === agent.id);
        const run = from === -1 ? [agent] : order.slice(Math.min(from, to), Math.max(from, to) + 1);
        // Every card in the run has to BE a chat before the set can name it, and each open lands in the column
        // the claim reserved for it.
        for (const card of run) {
            openBeside(card.id);
            open(card);
        }
        setPanes(run.map((card) => card.id));
        return true;
    }
    if (!event.altKey && !event.ctrlKey && !event.metaKey) {
        return false;
    }
    paneAnchor.value = agent.id;
    // Ctrl/Cmd toggles; Alt only ever adds, which is what makes it the safe one-shot.
    if ((event.ctrlKey || event.metaKey) && !event.altKey && panes.value.includes(agent.id) && panes.value.length > 1) {
        closePane(agent.id);
        return true;
    }
    openBeside(agent.id);
    open(agent);
    return true;
};

const focusAgent = (agent: FleetAgent, event?: MouseEvent): void => {
    // A drag's pointerup arrives here as a click on the card it started from; it must not also open the agent.
    if (consumeSuppressedOpen()) {
        return;
    }
    // The user is pointing the board somewhere themselves — whatever a deep link was highlighting is over.
    flashId.value = undefined;
    // This board made this selection, so it does not also scroll to it (see the selection watch).
    selectedHere = agent.id;
    // The click itself, before anything downstream can move it — the head of the focus trace (focusTrace.ts).
    traceFocus(`board-click`, { id: agent.id, status: agent.status });
    // A modified click asks for a column rather than the focus, and says so itself. Desktop only: panes live
    // in the pop-out window, and a phone navigates to the conversation instead of pointing anything at it.
    if (event !== undefined && !mobile.value && paneGesture(agent, event)) {
        return;
    }
    paneAnchor.value = agent.id;
    open(agent);
    if (mobile.value) {
        void router.push(`/agents/${encodeURIComponent(agent.id)}`);
        return;
    }
    // ...and an UNMODIFIED one is the reset those modifiers are defined against: whatever else was ringed gives
    // its column back, so "just this one" needs no cleanup after it. The split is one Alt+click away again and
    // the chats that left the screen are still in the rail, which is what makes this the cheap direction — and
    // it is the only thing that keeps a stale column out of the actions scoped to what is on screen
    // (Synthesize). Collapsing AFTER the open, since the chat to keep is the one the click just focused.
    collapsePanes();
};
// The deliberate view-change: focus the dock AND swap the surface to the agent's review detail. Fired by the
// card's contextual affordance or its double-click accelerator (never a plain click); the card only offers it
// for a registered agent, so there is always a detail to land on.
const reviewAgent = (agent: FleetAgent): void => {
    open(agent);
    void router.push(`/agents/${encodeURIComponent(agent.id)}`);
};
/* The only exit a card with no registry entry has (AgentCard's `closable`): closing its TAB, which is the same
 * conversation this card is the other skin of, so the card leaves the board with it. Not `archive` — there is
 * nothing daemon-side to file — and deliberately the identical act the chat rail's × performs, down to asking
 * for no confirmation, so the two surfaces cannot come to mean different things by the same press. */
const closeAgent = (agent: FleetAgent): void => {
    closeTabs(new Set([agent.id]));
};

/* --- The card's right-click menu ------------------------------------------------------------------
 * THE BOARD'S ONE MENU, driven by every card on it (the chat rail's tab menu, same shape) — forty cards cost
 * one node, and there is only ever one open.
 *
 * It exists because of what a card IS: a press that focuses the agent and a drag that moves it between lanes,
 * over a body that is otherwise all reading matter. Anything a user wants to do OCCASIONALLY therefore has
 * nowhere to sit — the session name spent a version as a small button in the middle of the card and was hit by
 * accident far more often than on purpose. So the rare things live behind the gesture that means "about this
 * one", and the card's surface goes back to answering one press one way.
 *
 * Nothing here is new: every row is a press the card already offers (the glyphs in its header, its
 * double-click, its contextual buttons). What the menu adds is a place to FIND them — two of those glyphs
 * appear only on hover, which is no affordance at all until you have already found it. */
const cardMenu = ref<{ show: (event: Event) => void } | undefined>();
const menuAgent = ref<FleetAgent>();

// Copied through the pressed CARD's document rather than this module's `navigator` — the app's one clipboard
// accessor (clipboardOf), which asks the element the gesture actually happened in.
const menuAnchor = ref<Element>();
const copySessionName = async (branch: string): Promise<void> => {
    try {
        await clipboardOf(menuAnchor.value).writeText(branch);
    } catch {
        // Clipboard may be unavailable (insecure context). The name is on the card either way.
    }
};

/* Written as GROUPS rather than one flat list with separators sprinkled through it. Almost every row here is
 * conditional — an agent holding a question offers no Archive, a main-tree conversation has no session name,
 * a draft has no review — so a separator written inline is a rule about rows that may not be rendered, and it
 * draws a line under the last item of a menu whose whole bottom group turned out to be empty. Grouping makes
 * the separator a property of the JOIN, which cannot dangle. */
const cardMenuItems = computed<MenuItem[]>(() => {
    const agent = menuAgent.value;
    if (agent === undefined) {
        return [];
    }
    const review = mobile.value ? undefined : reviewAction(agent);
    const branch = agent.branch;
    const groups: MenuItem[][] = [
        [
            { label: `Open`, icon: `arrow-right`, command: () => focusAgent(agent) },
            ...(review === undefined ? [] : [{ label: review, icon: `copy`, command: () => reviewAgent(agent) }]),
        ],
        /* The whole reason this menu was built. It hands over the BRANCH, which is what the card prints — the
           other forms of the name are labelled and visible before the press, on the agent's own page. */
        branch === undefined ? [] : [{ label: `Copy session name`, icon: `code`, command: () => void copySessionName(branch) }],
        [
            ...(agent.archivedAt !== undefined
                ? [{ label: `Restore`, icon: `history`, command: () => restore([agent.id]) }]
                : canArchive(agent)
                  ? [{ label: `Archive`, icon: `box`, command: () => archive([agent.id]) }]
                  : []),
            ...(unregistered(agent.status) ? [{ label: `Close`, icon: `times`, command: () => closeAgent(agent) }] : []),
        ],
    ];
    const items: MenuItem[] = [];
    for (const group of groups.filter((candidate) => candidate.length > 0)) {
        if (items.length > 0) {
            items.push({ separator: true });
        }
        items.push(...group);
    }
    return items;
});

const openCardMenu = (agent: FleetAgent, event: MouseEvent): void => {
    menuAgent.value = agent;
    menuAnchor.value = event.currentTarget instanceof Element ? event.currentTarget : undefined;
    cardMenu.value?.show(event);
};
/* --- Workflow runs on the board ------------------------------------------------------------------
 * A run is not an agent (WorkflowRunCard says why at length), so it is a SECOND list rendered into the same
 * lanes rather than a row in `fleet`. It sits at the top of its lane: a run is the container of several cards
 * below it, and a container under its contents is a heading in the wrong place.
 *
 * The finished lane is capped at the same window the agents use and offers no "show earlier" row of its own.
 * That lane's job is to confirm what just completed; the run HISTORY is the workflows page, which keeps the
 * last fifty and draws each one as the graph it was.
 */
const openRunGraph = (run: WorkflowRun): void => {
    void router.push({ name: `extension`, params: { ext: `workflows` }, query: { run: run.runId } });
};

/* OPENING A RUN PUTS ITS SESSIONS IN THE CHAT PANEL, one column each — openRunInChat, shared with the rail's
 * row so the two doors into a run cannot drift.
 *
 * IT DOES NOT NAVIGATE, and that is the correction: sending the main view to the workflows extension answered
 * a question nobody asked. What a person wants from a run in flight is the transcripts — several at once,
 * which is precisely what the popped-out panel is for — and a page showing a picture of them is a detour on
 * the way there. The picture is still one press away, as the panel's own back arrow (chatRun's two modes).
 */
const openRun = (run: WorkflowRun): void => void openRunInChat(run);

// Which runs have been asked to stop and have not settled yet. The abort reaches the turns at once, but the
// LEDGER only says so once each step has unwound and the scheduler has written the run's outcome — and this
// card is drawn off the ledger, on a poll. Without the mark it looks untouched until then, which is exactly
// how a Stop gets pressed four times.
const stoppingRuns = ref(new Set<string>());
const forgetStopping = (runId: string): void => {
    const rest = new Set(stoppingRuns.value);
    rest.delete(runId);
    stoppingRuns.value = rest;
};
const stopRun = async (run: WorkflowRun): Promise<void> => {
    stoppingRuns.value = new Set([...stoppingRuns.value, run.runId]);
    try {
        await stopWorkflowRun.mutateAsync(run.runId);
    } catch {
        // The usual cause is that it ended between the render and the press. Whatever it was, a stop that did
        // not take must not leave the card disabled — the ask is over, and the run says the rest itself.
        forgetStopping(run.runId);
    }
};
// File an ended run away, sessions and all, and put one back. No confirmation on the agent card's own
// argument: archiving is lossless — the branches, the transcripts and the counters all stay — and the way back
// is the archive itself, permanently, rather than a receipt that has to still be on screen.
const archiveRun = async (run: WorkflowRun): Promise<void> => {
    await archiveWorkflowRun.mutateAsync(run.runId).catch(() => undefined);
};
const restoreRun = async (run: WorkflowRun): Promise<void> => {
    await unarchiveWorkflowRun.mutateAsync(run.runId).catch(() => undefined);
};
// The mark is held until the LEDGER says the run is no longer going, not until the request returns: the
// request acks the ask, and steps in flight are still finishing the round they are on for minutes after it.
watch(workflowRuns, (list) => {
    for (const runId of stoppingRuns.value) {
        if (list.find((run) => run.runId === runId)?.state !== `running`) {
            forgetStopping(runId);
        }
    }
});

/* --- Held wakes on the board ---------------------------------------------------------------------
 * The approvals queue's rows, in the Attention lane only — a hold's entire meaning is "waiting on you", and
 * there is no conversation behind it yet to place anywhere else. Releasing one is detached daemon-side (the
 * turn outlives the request), so the row leaves on the store's optimistic remove; `busyHeld` covers the gap
 * between the press and that removal so a slow answer cannot collect two presses. */
const busyHeld = ref(new Set<string>());
const releaseWake = async (id: string, verb: `approve` | `reject`): Promise<void> => {
    busyHeld.value = new Set([...busyHeld.value, id]);
    try {
        await releaseHeld(id, verb);
    } catch {
        // The usual cause is the countdown ran it (or another device answered) between the render and the
        // press — refresh repaints the truth either way.
        void refresh();
    } finally {
        const rest = new Set(busyHeld.value);
        rest.delete(id);
        busyHeld.value = rest;
    }
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
             field dropping to its own second row, the row wins — a 90px search box is not a search box. The
             field stays compact on a roomy board, and it is the bar's centre rather than a left-hand
             afterthought: the two sides flank it on equal `flex-1 basis-0` tracks, so the field sits in the
             middle of the BAR and not merely in whatever space the left group happened to leave.
             That second row has to be ASKED for. `flex-1 basis-0` means the flanks measure zero, so the line
             always "fits" (0 + 288 + 0) and nothing ever wraps — while their `shrink-0` contents render at full
             width anyway, straight over the field. On a phone that put "New agent" across the field's right end
             and both pills UNDER it: invisible, and the unread pill is the only way to mark all read, so the
             board lost it entirely. Below the same width at which the lanes stack, the field takes a row of its
             own and the flanks keep the first one to themselves. -->
        <div class="view-header view-header-wrap flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1">
            <div class="flex min-w-0 flex-1 basis-0 items-center gap-2">
                <span class="shrink-0 text-sm font-semibold text-content">Agents</span>
                <!-- Two different facts, two different pills: "needs you" is BLOCKED work (an approval, a
                     question, a conflict, an error) and earns the warning colour; "unread" is only "you haven't
                     looked yet" and stays informational — with its own way out, so silencing the board never
                     means clicking through every card. -->
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
            </div>
            <SearchBar
                ref="filterField"
                v-model="query"
                variant="field"
                clearable
                :busy="searching"
                aria-label="Filter agents by your messages"
                placeholder="Filter by your messages…"
                class="mx-auto max-w-full shrink-0"
                :class="narrow ? 'order-last basis-full' : 'w-72'"
            />
            <div class="flex min-w-0 flex-1 basis-0 items-center justify-end gap-2">
                <!-- The tally, so an empty board under a query reads as "nothing matched" rather than as a board
                     that broke. Only while filtering: the lane headers already carry the unfiltered counts. -->
                <span v-if="filtering" class="shrink-0 text-2xs text-muted">{{ matchTally }}</span>
                <!-- The panes on screen ARE the selection (the ringed cards), so this appears exactly when two
                     or more chats sit side by side — press it and a fresh draft chat opens over their full
                     transcripts, composed but NOT sent (synthesizeSessions.ts). -->
                <Button
                    v-if="panes.length >= 2"
                    size="small"
                    severity="secondary"
                    :disabled="synthesizing"
                    class="shrink-0 gap-1 px-2.5 py-1 text-2xs"
                    @click="synthesize"
                >
                    <Icon :name="synthesizing ? `spinner` : `sparkles`" :spin="synthesizing" class="text-2xs" />Synthesize {{ panes.length }}
                </Button>
                <Button size="small" class="shrink-0 gap-1 px-2.5 py-1 text-2xs" @click="startAgent()">
                    <Icon name="plus" class="text-2xs" />New agent
                </Button>
            </div>
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
        <div v-if="(!started || total === 0) && !archiveOpen" class="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-4 text-center">
            <!-- THE FIRST RUN: nothing has ever happened here, so the screen asks for a task. The question
                 comes first, and it is a QUESTION — this screen's job is to be answered, not read. -->
            <template v-if="!started">
                <div class="flex w-full max-w-xl flex-col gap-2">
                    <h2 class="text-sm font-semibold text-content">What should the first agent do?</h2>
                    <p class="text-2xs text-muted">
                        Describe a task and it runs on its own branch while you carry on — you review what it did before anything lands in your
                        workspace.
                    </p>
                </div>
            </template>
            <!-- A BOARD THAT HAS BEEN CLEARED, which is a different silence: this user knows what agents are,
                 and what they need is the way back to the ones they filed away (the pill below). -->
            <template v-else>
                <Icon name="sparkles" class="text-3xl text-subtle" />
                <p class="max-w-sm text-xs text-muted">
                    Nothing on the board. Start a conversation here or in the workspace; both appear on this board, and isolated work remains
                    reviewable on its own branch.
                </p>
            </template>
            <template v-if="!started">
                <!-- The composer. Enter sends and Shift+Enter breaks the line, which is the docked chat's contract
                     one column over; a first box that answered those two keys differently would teach the wrong
                     reflex on the very first press. -->
                <div class="flex w-full max-w-xl flex-col gap-2 rounded-xl border border-line bg-card p-2 text-left focus-within:border-primary-500">
                    <textarea
                        ref="firstTaskField"
                        v-model="firstTask"
                        rows="3"
                        aria-label="What should the first agent do?"
                        placeholder="e.g. Explain this codebase and point me at the entry points"
                        class="scrollbar-thin block max-h-40 w-full resize-none bg-transparent px-2 pt-1 text-xs leading-relaxed text-content placeholder:text-subtle focus:outline-none"
                        @keydown.enter.exact.prevent="sendFirstTask"
                    ></textarea>
                    <div class="flex items-center justify-end">
                        <Button size="small" :disabled="firstTask.trim().length === 0" class="gap-1 px-2.5 py-1 text-2xs" @click="sendFirstTask">
                            <Icon name="sparkles" class="text-2xs" />Start agent
                        </Button>
                    </div>
                </div>
                <!-- Tasks worth pressing, read off what is actually in the workspace (see `starters`). They fill the
                     box rather than dispatching, so the user sends their own first turn. -->
                <div class="flex max-w-xl flex-wrap items-center justify-center gap-1.5">
                    <button
                        v-for="starter in starters"
                        :key="starter.label"
                        type="button"
                        class="rounded-full border border-line px-2.5 py-1 text-2xs text-muted transition-colors hover:border-line-strong hover:bg-overlay hover:text-content"
                        @click="useStarter(starter.prompt)"
                    >
                        {{ starter.label }}
                    </button>
                </div>
            </template>
            <!-- Clearing the last lane lands the user here, so the empty state carries the pulse too — it is
                 the only archive affordance left on screen once the board is bare. -->
            <button
                v-if="archiveSize > 0"
                type="button"
                class="inline-flex items-center gap-1 rounded px-1 py-px text-2xs text-link transition-colors hover:underline"
                :class="pulsing ? 'bg-primary-600/25 ring-1 ring-primary-500/50' : ''"
                @click="toggleArchive"
            >
                <Icon name="history" class="text-2xs" />{{ archiveSize }} archived agent{{ archiveSize === 1 ? "" : "s" }}
            </button>
        </div>
        <!-- The scroller carries no padding of its own: the stacked board's lane headers pin to `top-0`, and a
             padded scrollport would leave a strip above them for the cards to scroll through.
             It is one of the few `.scrollbar-stable` boxes in the app: a lane filling past the fold is ordinary
             traffic here, and without the gutter three columns re-flow sideways the moment the bar appears. The
             shell's own route scroller deliberately has no gutter, so this is the only strip on the board's
             right edge rather than the third of three. -->
        <div v-else class="scrollbar-thin scrollbar-stable min-h-0 flex-1 overflow-auto">
            <!-- Stacked, the lanes are rows of one grid that is still `h-full` (so a lane keeps a drop target
                 when the board is empty) — `content-start` is what stops those rows from stretching to fill it
                 and leaving a lane's cards floating a hundred pixels above the next header. -->
            <div class="grid h-full gap-3 p-3" :class="narrow ? 'content-start' : 'grid-cols-3 items-start'">
                <section
                    v-for="lane in LANES"
                    :key="lane.key"
                    :data-drop="lane.key === 'finished' && archiveOpen ? undefined : lane.key"
                    class="lane flex min-w-0 flex-col rounded-xl transition-colors"
                    :class="[!dragging && !narrow ? 'min-h-0' : '', laneDropClass(lane.key)]"
                >
                    <!-- The Finished lane doubles as the archive's window, so its header is the one that
                         changes: in archive mode it swaps its dot and label and grows a way back.
                         Stacked, the header also becomes the lane's marker while you scroll: three lanes down
                         one page is a page and a half of cards, and a card is only readable as "finished" if
                         the lane it belongs to is still on screen. It pins inside its own section, so it
                         leaves with it rather than sitting over the next lane's cards. -->
                    <!-- Pinned, it paints the LANE's own fill (.lane-header) rather than canvas: a header a
                         shade off the slab it caps is a seam across the column. -->
                    <header class="flex items-center gap-2 px-3 py-2" :class="narrow ? 'lane-header sticky top-0 z-10 rounded-t-xl' : ''">
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
                                v-if="archiveSize > 0"
                                type="button"
                                :aria-label="`Open the archive (${archiveSize})`"
                                v-tooltip.bottom="'Taken off the board — branches and conversations are kept'"
                                class="inline-flex shrink-0 items-center gap-1 rounded px-1 py-px text-2xs transition-colors"
                                :class="
                                    pulsing
                                        ? 'bg-primary-600/25 text-link ring-1 ring-primary-500/50'
                                        : 'text-muted hover:bg-overlay hover:text-content'
                                "
                                @click="toggleArchive"
                            >
                                <Icon name="history" class="text-2xs" />{{ archiveSize }}
                            </button>
                            <!-- Gone while filtering, for the reason the drag is (grabCard): "Clear" archives
                                 the WHOLE lane, and offering it above a lane showing "1 of 12" is offering a
                                 bulk action whose scope is not the one on screen. -->
                            <button
                                v-if="clearable > 0 && !filtering"
                                type="button"
                                aria-label="Archive every finished agent"
                                v-tooltip.bottom="`Archive all ${clearable} — you can undo it`"
                                class="shrink-0 rounded px-1 py-px text-2xs text-muted transition-colors hover:bg-overlay hover:text-content"
                                @click="archive()"
                            >
                                Clear
                            </button>
                        </template>
                        <!-- The archive's own bulk exit, in the slot "Clear" occupies on the live lane — the
                             same position for the same kind of act, and the opposite weight. Danger only on
                             hover, so a column of retired agents doesn't read as a hazard while you browse it;
                             the dialog is what actually guards it. Gone while filtering, exactly as Clear is:
                             this deletes the WHOLE archive, and offering it above a list reading "1 of 12" is
                             offering a bulk action whose scope is not the one on screen.
                             It counts CONVERSATIONS while the header above counts rows, and the difference is
                             the point: a workflow row is one thing to browse past and four transcripts to
                             destroy, and the number on an irreversible act is the cost, not the tidy view. -->
                        <button
                            v-if="lane.key === 'finished' && archiveOpen && archiveSize > 0 && !filtering"
                            type="button"
                            :aria-label="`Delete all ${archived.length} archived agents permanently`"
                            :disabled="purging"
                            v-tooltip.bottom="`Delete all ${archived.length} permanently — branches and all. This can't be undone.`"
                            class="inline-flex shrink-0 items-center gap-1 rounded px-1 py-px text-2xs text-muted transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                            @click="pendingPurge = true"
                        >
                            <Icon :name="purging ? 'spinner' : 'trash'" :spin="purging" class="text-2xs" />Delete all
                        </button>
                    </header>
                    <!-- The lane's HELD WAKES, first of all: a hold is the one row here that is WHOLLY waiting
                         on you — everything below it is at least running. Attention lane only (HeldWakeCard
                         says why), and outside the TransitionGroup for the runs' reason. -->
                    <div v-if="lane.key === 'attention' && !archiveOpen && heldWakes.length > 0" class="flex flex-col gap-2 px-2 pb-2">
                        <HeldWakeCard
                            v-for="entry in heldWakes"
                            :key="entry.id"
                            :entry="entry"
                            :busy="busyHeld.has(entry.id)"
                            @approve="releaseWake(entry.id, `approve`)"
                            @reject="releaseWake(entry.id, `reject`)"
                        />
                    </div>
                    <!-- The lane's WORKFLOW RUNS, above its agents: a run is the container of several of the
                         cards below it, and a container drawn under its contents is a heading in the wrong
                         place. Outside the TransitionGroup below — that group's FLIP animation is over the
                         fleet, and a row of another kind moving through it would drag the cards it holds.
                         In the archive it is the archived runs that list here, in the same slot: the steps
                         filed away with a run have no cards of their own there either. -->
                    <div v-if="runsFor(lane.key).length > 0" class="flex flex-col gap-2 px-2 pb-2">
                        <WorkflowRunCard
                            v-for="run in runsFor(lane.key)"
                            :key="run.runId"
                            :run="run"
                            :selected="chatRun?.runId === run.runId"
                            :needs-you="needingYou.has(run.runId)"
                            :stopping="stoppingRuns.has(run.runId)"
                            @open="openRun(run)"
                            @graph="openRunGraph(run)"
                            @stop="stopRun(run)"
                            @archive="archiveRun(run)"
                            @restore="restoreRun(run)"
                        />
                    </div>
                    <p
                        v-if="lane.key === 'finished' && archiveOpen && archivedCards.length === 0 && runsFor('finished').length === 0"
                        class="px-3 pb-3 text-2xs text-subtle"
                    >
                        {{
                            purged
                                ? "Archive emptied. Finished agents will collect here again on their own after a few quiet days."
                                : "Nothing archived yet. Finished agents land here on their own after a few quiet days."
                        }}
                    </p>
                    <!-- An emptied lane keeps its header and says so on one line. It does NOT disappear: three
                         columns collapsing to one as the query lands makes the whole board jump under the
                         cursor mid-keystroke, and the lane you were about to read moves out from under it. A
                         lane holding only a run — or, in Attention, only a held wake — is not empty, whatever
                         the fleet half of it says. -->
                    <p
                        v-else-if="
                            cardsFor(lane.key).length === 0 && runsFor(lane.key).length === 0 && !(lane.key === 'attention' && heldWakes.length > 0)
                        "
                        class="px-3 pb-3 text-2xs text-subtle"
                    >
                        {{ filtering ? "No matches in this lane." : lane.empty }}
                    </p>
                    <TransitionGroup v-else tag="div" name="lane" class="relative flex flex-col gap-2 px-2 pb-2">
                        <AgentCard
                            v-for="agent in cardsFor(lane.key)"
                            :key="agent.id"
                            :ref="(el) => setCardEl(agent.id, el)"
                            :agent="agent"
                            :now="now"
                            :dense="narrow"
                            :dragging="draggedId === agent.id && dragging"
                            :pending="pendingFor(agent)"
                            :selected="agent.id === highlightId || inPane(agent.id)"
                            :match="snippetOf(agent)"
                            :query="needle"
                            @open="(event) => focusAgent(agent, event)"
                            @review="reviewAgent(agent)"
                            @resolve="resolveNow(agent.id)"
                            @land="landNow(agent.id)"
                            @reland="relandNow(agent.id)"
                            @archive="archive([agent.id])"
                            @restore="restore([agent.id])"
                            @close="closeAgent(agent)"
                            @grab="(event, card) => grabCard(event, agent, card)"
                            @contextmenu.prevent.stop="openCardMenu(agent, $event)"
                        />
                    </TransitionGroup>
                    <!-- The lane's tail, not a pager: the count is the point ("there are 12 more"), and the row
                         is what keeps them one press away instead of gone. Gone while filtering — the window is
                         lifted there (see cardsFor), so there is nothing behind it to offer. -->
                    <button
                        v-if="lane.key === 'finished' && !archiveOpen && !filtering && hiddenFinished > 0"
                        type="button"
                        :class="cmp.addTile(`mx-2 mb-2 gap-1 rounded-lg py-1.5 text-2xs`)"
                        @click="showAllFinished = !showAllFinished"
                    >
                        <Icon :name="showAllFinished ? 'chevron-up' : 'chevron-down'" class="text-2xs" />
                        {{ showAllFinished ? "Show fewer" : `${hiddenFinished} earlier` }}
                    </button>
                </section>
            </div>
            <!-- The filter's own empty state, which is NOT the empty board's: there are agents, just none of
                 them this one. Says what was searched, so a typo is visible without looking back up at the
                 field, and names the rule — the commonest reason for a miss is searching for something the
                 AGENT said rather than something you did. -->
            <p v-if="noMatches" class="px-4 pb-6 text-center text-2xs text-subtle">
                No agent of yours mentions “{{ query.trim() }}”. This searches the messages you wrote — not the agents' replies.
            </p>
        </div>
        <!-- WHAT THE QUERY FOUND OFF THE BOARD. The board hides by design — the Finished lane windows to a
             handful and archived agents leave the roster entirely — so a filter confined to the lanes would
             answer "no matches" for an agent sitting one click away, and the user only has to catch that
             once to stop believing the field. One row reports the count; expanding it puts the archive's
             hits on real cards (restore and all) and the never-carded conversations on history rows.
             Collapsed by default, and re-collapsed on every new query: the board is the answer, this is
             its footnote.
             It sits OUTSIDE the board's scroller, as the column's own last row: inside it, the lane grid is
             `h-full` and pushes the row past the bottom of the view, so the one line that says a hit exists
             off the board can only be reached by scrolling to look for something you don't know is there.
             Expanded, it takes at most half the column and scrolls itself, so the board above it never
             disappears. -->
        <div v-if="beyondVisible" class="flex max-h-[50%] shrink-0 flex-col border-t border-line px-3 pb-3 pt-2">
            <button
                type="button"
                class="flex w-full shrink-0 items-center gap-2 rounded-lg px-1 py-1 text-2xs text-muted transition-colors hover:text-content"
                :aria-expanded="showBeyond"
                @click="showBeyond = !showBeyond"
            >
                <Icon name="search" class="shrink-0 text-2xs text-subtle" />
                <span class="min-w-0 flex-1 truncate text-left">{{ beyondLabel }}</span>
                <span class="shrink-0 font-medium text-link">{{ showBeyond ? "Hide" : "Show" }}</span>
                <Icon :name="showBeyond ? 'chevron-up' : 'chevron-down'" class="shrink-0 text-2xs" />
            </button>
            <div v-if="showBeyond" class="scrollbar-thin mt-2 flex min-h-0 flex-col gap-3 overflow-auto">
                <section v-if="archivedHits.length > 0" class="flex min-w-0 flex-col gap-2">
                    <div class="flex items-center gap-2 px-1">
                        <Icon name="box" class="shrink-0 text-2xs text-subtle" />
                        <span class="text-2xs font-semibold uppercase tracking-wide text-muted">In the archive</span>
                        <span class="rounded-full bg-overlay px-1.5 py-px text-2xs text-muted">{{ archivedHits.length }}</span>
                    </div>
                    <!-- Real cards, not a stripped-down list: an archived agent keeps its branch, its diff
                         and its transcript, so the thing the user wants to do with a hit here — read it,
                         restore it — is exactly what the card already offers. -->
                    <div class="grid gap-2" :class="narrow ? '' : 'grid-cols-3 items-start'">
                        <AgentCard
                            v-for="agent in archivedHits"
                            :key="agent.id"
                            :agent="agent"
                            :now="now"
                            :dense="narrow"
                            :pending="pendingFor(agent)"
                            :selected="agent.id === highlightId || inPane(agent.id)"
                            :match="snippetOf(agent)"
                            :query="needle"
                            @open="(event) => focusAgent(agent, event)"
                            @review="reviewAgent(agent)"
                            @restore="restore([agent.id])"
                            @contextmenu.prevent.stop="openCardMenu(agent, $event)"
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
                        <MatchLine
                            v-if="session.snippet !== undefined"
                            :snippet="session.snippet"
                            :needle="needle"
                            class="line-clamp-2 text-2xs text-muted"
                        />
                        <span class="text-2xs text-subtle">{{ relativeTime(session.updatedAt) }}</span>
                    </button>
                </section>
            </div>
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
                <Button size="small" label="Ask the agent" class="px-3 py-1" @click="confirmResolve" />
            </template>
        </Dialog>
        <!-- The one dialog on this board that guards something unrecoverable. It says what GOES in the terms the
             archive has been promising all along ("nothing is lost" — this is the press that revokes it) and
             what STAYS, because the commonest fear here is about work already landed in the workspace, which is
             the one thing deletion cannot touch. The destructive button names the count rather than saying
             "Delete": the number is the whole difference between clearing three throwaways and twelve agents. -->
        <Dialog
            :visible="pendingPurge"
            :modal="true"
            :draggable="false"
            :dismissable-mask="true"
            :style="{ width: '26rem' }"
            header="Delete every archived agent?"
            @update:visible="pendingPurge = false"
        >
            <p class="text-xs text-content">
                {{ archived.length }} archived agent{{ archived.length === 1 ? "" : "s" }} will be deleted for good — each one's branch, its
                conversation and its history. This cannot be undone.
            </p>
            <p class="mt-2 text-xs text-muted">
                Work they already landed stays in your workspace. Only what never left their branches is lost. Agents still on the board are
                untouched.
            </p>
            <template #footer>
                <button type="button" class="rounded px-3 py-1 text-xs text-muted hover:text-content" @click="pendingPurge = false">Cancel</button>
                <Button size="small" severity="danger" class="px-3 py-1" @click="confirmPurge">
                    Delete {{ archived.length }} agent{{ archived.length === 1 ? "" : "s" }}
                </Button>
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
                :class="action !== undefined ? 'bg-primary-fill/10 text-primary-fill border border-primary-fill/20' : 'bg-overlay text-subtle'"
            >
                {{ hint }}
            </p>
        </div>
        <!-- One menu for every card on the board — see cardMenuItems. -->
        <ContextMenu ref="cardMenu" :model="cardMenuItems" :min-width="12" />
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
