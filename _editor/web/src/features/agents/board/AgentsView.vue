<script setup lang="ts">
import type { Disposable } from "@intentic/extension-api";
import { isTrialProvider, type WorkflowRun } from "@intentic/sandbox-contract";
import { Button, clipboardOf, ui, ContextMenu, Modal, SearchBar, SegmentedControl, useDevice, useNarrow } from "@intentic/ui";
import type { MenuItem } from "primevue/menuitem";
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { composeAgent, startAgent } from "../fleet/agentActions";
import { usePanels } from "../../extensions/usePanels";
import { useChanges } from "../../workspace/changes/useChanges";
import { synthesizeSessions, synthesizing } from "../fleet/synthesizeSessions";
import { dropActionLabel, dropRejection, type PendingAction } from "./laneDrop";
import { useAgentDrag } from "./useAgentDrag";
import { useAgentFilter } from "./useAgentFilter";
import { type FleetLane, reviewAction, unregistered, watching } from "../fleet/agentStatus";
import { useAgents } from "../fleet/useAgents";
import { agentSeed } from "../fleet/useAgents-actions";
import { canArchive, FINISHED_WINDOW, type FleetAgent, laneGroups, windowFinished } from "../fleet/useAgents-fleet";
import { boxNameOf, fleetScope, isRemote, openInSandbox, otherFleet, partialAnswer, readingAcross, scopeOffered } from "../fleet/fleetScope";
import { refreshAcross, subscribe as watchOtherBoxes } from "../../sandbox/live/fleetAcross";
import { insideRun, laneOfRun, runIdsInLedger, runMatches, runsInLane, runsNeedingYou, useWorkflowRuns } from "../fleet/useWorkflowRuns";
import { hold } from "../../../shell/notifications/notifications";
import { relativeTime } from "../../chat/models/catalog";
import { chatRun, showingRunGraph } from "../../chat/run/chatRun";
import { chatWide } from "../../chat/panel/chatPanelLayout";
import { openRunInChat } from "../../chat/run/openRun";
import { traceFocus } from "../../chat/run/focusTrace";
import { summonChat } from "../../chat/run/summon";
import { useChat } from "../../chat/run/useChat";
import { chatStrip } from "../../chat/panel/useChat-strip";
import { agentTabOf } from "../../chat/panel/useChat-reveal";
import { publishContextKey } from "../../../shell/commands/contextKeys";
import { commandShortcut, registerCommand } from "../../../shell/commands/useCommands";
import MatchLine from "../../../components/MatchLine.vue";
import { BUILD_IDEAS, buildPrompt } from "./buildIdeas";
import AgentCard from "./AgentCard.vue";
import HeldWakeCard from "./HeldWakeCard.vue";
import WorkflowRunCard from "./WorkflowRunCard.vue";
import { uuid } from "../../../lib/uuid";
// Kanban across Attention/Active/Finished, pure projections of laneOf; a drop runs the action that causes a lane change
// (laneDrop), never assigns status directly.
// Board is sized by its own width, not the viewport's: below NARROW_BOARD_PX the three lanes stack instead of columns,
// same lanes/order/counts/drop targets either way.
// Finished has no way out on its own, so it gets a window (FINISHED_WINDOW), a Clear, and an Archive view; archiving is
// lossless (no confirm); the archive's own "Delete all" is bulk-only and confirms first.
const router = useRouter();
const route = useRoute();
const { mobile } = useDevice();
const {
    lanes,
    fleet,
    heldWakes,
    releaseHeld,
    refresh,
    open,
    markSeen,
    archived,
    archiveLoading,
    loadArchived,
    archive,
    restore,
    stopWatching,
    purgeArchived,
    undoArchive,
    undoable,
    archivedFlash,
    notice,
    dismissNotice,
    busyIds,
    agentById,
} = useAgents();
// Whole store, not a destructure: the first-screen connect offer acts on the focused chat, and the card is that
// conversation's view as one object.
const chat = useChat();
const { active, panes, connected, accountsLoaded } = chat;
// A refusal lands on the board's notice strip, since a press with no visible effect reads as broken.
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
    pendingOn,
    ghostStyle,
    begin,
    consumeSuppressedOpen,
    pendingResolve,
    confirmResolve,
    cancelResolve,
    resolveNow,
    landNow,
    relandNow,
    unwatchNow,
} = useAgentDrag();
// Looked up live, not snapshotted with the drop, so a rename or status change while the dialog is open is reflected in
// it.
const resolveTarget = computed(() => (pendingResolve.value === undefined ? undefined : agentById(pendingResolve.value)));
// What a card is waiting on: an in-flight press/drop (useAgentDrag, self-naming) or an archive/restore batch addressed
// by id alone.
// An id in that batch is being filed away, unless already archived, in which case it's being restored.
const pendingFor = (agent: FleetAgent): PendingAction | undefined => {
    // Matched on the card, not the id: an agent id can repeat across sandboxes (a cloned workspace), so an id-only test
    // would dim both cards for one action.
    // useAgentDrag keys in-flight actions per card for the same reason.
    const running = pendingOn(agent.id, agent.sandboxId);
    if (running !== undefined) {
        return running;
    }
    // Archive/restore are the active box's alone, so a card from elsewhere can never be in that busy set, whatever its
    // id says.
    if (agent.sandboxId !== undefined || !busyIds.value.includes(agent.id)) {
        return undefined;
    }
    return agent.archivedAt !== undefined ? `restore` : `archive`;
};
// Matches the card's title and every later prompt in that agent's transcript; local for tabs this browser holds,
// daemon-side for the rest (see useAgentFilter).
// The field is always visible, not behind a glyph, so nobody has to learn the board is searchable; `Aa` is a preference
// inside it, not part of the query.
const {
    query,
    needle,
    matchCase,
    active: filtering,
    matches,
    snippetOf,
    archivedMatches,
    sessionMatches,
    searching,
    partial: searchPartial,
} = useAgentFilter();
const filterField = ref<InstanceType<typeof SearchBar> | undefined>(undefined);
// Finished lane's two extra view states, held here rather than in the store: they're how this one board is being looked
// at, not something a second surface should inherit.
const showAllFinished = ref(false);
const archiveOpen = ref(false);
// The Finished window only applies while browsing its own recent tail; a filter or explicit expand lifts the cap (see
// cardsFor).
const windowed = computed(() => !archiveOpen.value && !filtering.value && !showAllFinished.value);

const { runs: workflowRuns, stop: stopWorkflowRun, archive: archiveWorkflowRun, unarchive: unarchiveWorkflowRun } = useWorkflowRuns();
// Read from the fleet, not the run ledger: "blocked" is a live fact about the conversation, and the ledger only knows
// what the scheduler wrote.
const needingYou = computed(() => runsNeedingYou(fleet.value));
// A run under a query answers for its steps, since they have no cards of their own to answer with (runMatches).
const runKept = (run: WorkflowRun): boolean => !filtering.value || runMatches(run, needle.value, fleet.value, matches);
// Both halves of the ledger, kept in both list and filtered forms: an archived run is off the board like an archived
// agent, shown in Finished's archive view instead.
// Kept in both forms since a "n of m" count needs the unfiltered denominator too.
const boardRunRows = computed(() => workflowRuns.value.filter((run) => run.archivedAt === undefined));
const liveRuns = computed(() => boardRunRows.value.filter(runKept));
const archivedRunRows = computed(() => workflowRuns.value.filter((run) => run.archivedAt !== undefined));
const archivedRuns = computed(() => archivedRunRows.value.filter(runKept));
const runsFor = (lane: FleetLane): WorkflowRun[] => {
    // The archive is a different list wearing Finished's shape: only its runs show; the other two lanes have nothing
    // while it's open.
    if (archiveOpen.value) {
        return lane === `finished` ? archivedRuns.value : [];
    }
    // Window caps Finished while browsing, lifted by a filter or the lane's own expand, same rule as the agents' (a
    // capped run hides its steps too).
    return runsInLane(liveRuns.value, lane, windowed.value ? FINISHED_WINDOW : Number.POSITIVE_INFINITY, needingYou.value);
};

// A run's steps live inside its row, never as separate cards: otherwise a five-step workflow shows as one run card plus
// five agent cards for the same work.
// Gated on the ledger, not on the run being drawn: every reason a row is off-screen (filter, window, archive) must also
// pull its conversations off the board.
const BOARD_LANES = [`attention`, `active`, `finished`] as const;
const ledgerRunIds = computed(() => runIdsInLedger(workflowRuns.value));

// Lanes group by the same rule (laneGroups) whether scope is `box` (this fleet) or `all` (plus every other box's
// roster), so the two scopes can never order a column differently.
// Sandbox is never a column or sort key: a column per box reproduces the exact problem the wider board exists to solve.
const scopedFleet = computed<FleetAgent[]>(() => (readingAcross.value ? [...fleet.value, ...otherFleet.value] : fleet.value));
const scopedLanes = computed<Record<FleetLane, FleetAgent[]>>(() => (readingAcross.value ? laneGroups(scopedFleet.value) : lanes.value));

const boardLanes = computed<Record<FleetLane, FleetAgent[]>>(() => {
    if (ledgerRunIds.value.size === 0) {
        return scopedLanes.value;
    }
    const outside = (agent: FleetAgent): boolean => !insideRun(agent, ledgerRunIds.value);
    return {
        attention: scopedLanes.value.attention.filter(outside),
        active: scopedLanes.value.active.filter(outside),
        finished: scopedLanes.value.finished.filter(outside),
    };
});

// The wider-board store runs only while the board is asking for it (scope `all` and the route visible); flipping the
// scope starts and stops it.
let releaseBoxes: (() => void) | undefined;
watch(
    readingAcross,
    (across) => {
        if (across) {
            releaseBoxes ??= watchOtherBoxes();
            return;
        }
        releaseBoxes?.();
        releaseBoxes = undefined;
    },
    { immediate: true },
);
onUnmounted(() => {
    releaseBoxes?.();
    releaseBoxes = undefined;
});

// Says when the Attention lane's answer is only partial (some boxes haven't answered yet), since an empty lane is
// otherwise a false claim that nothing needs the user.
// Lives in the lane, not a page-wide strip, as a `condition`: true only while it holds, gone the moment it resolves, no
// dismissal needed since nothing is owed.
const releaseNotice = hold(`fleet-partial`, () => {
    const partial = partialAnswer.value;
    return partial === undefined
        ? undefined
        : {
              kind: `condition`,
              tone: `warning`,
              title: partial.title,
              detail: partial.detail,
              actions: [{ label: `Try again`, severity: `secondary` as const, run: refreshAcross }],
          };
});
onUnmounted(releaseNotice);

const SCOPE_OPTIONS = [
    { label: `This sandbox`, value: `box` as const },
    { label: `All sandboxes`, value: `all` as const },
];
// Excludes a run's steps, which are filed away with the run itself, or the archive would show one run row plus its five
// conversations.
const archivedCards = computed(() => archived.value.filter((agent) => !insideRun(agent, ledgerRunIds.value)));
// How many rows the archive would draw: a run with four steps counts as one row there, not five.
const archiveSize = computed(() => archivedCards.value.length + archivedRunRows.value.length);
// The archive isn't self-limiting like the live lanes, so it's paged rather than drawn whole, which used to build
// thousands of cards in one frame on a large workspace.
// Grows only (a page added, never dropped), since the archive is browsed and searched, unlike Finished's fixed
// confirming window.
const ARCHIVE_PAGE = 30;
const archiveShown = ref(ARCHIVE_PAGE);
// Filters the whole pile first, then pages the result, never the reverse, or a match nine hundred rows down reads as no
// match.
const archiveRows = computed(() => (filtering.value ? archivedCards.value.filter(matches) : archivedCards.value));
const archiveHidden = computed(() => Math.max(0, archiveRows.value.length - archiveShown.value));

// A run's design lives on the workflows page; this board only answers "what is it doing". Results off the board are
// collapsed by default and reset on every new query.
const showBeyond = ref(false);
// A new query is a new list: an archive scrolled deep, or "show more" expanded, both describe a set that no longer
// exists.
watch(needle, () => {
    showBeyond.value = false;
    archiveShown.value = ARCHIVE_PAGE;
});
// Which card wears the ring: normally the docked chat's agent (desktop only), or briefly the one a link just focused
// (flashId, cleared by its own timer).
// Board-wide state, not a paint, since the Finished window and cross-board selections both need to read it too.
const flashId = ref<string | undefined>(undefined);
// Takes the ring off every agent while a run's diagram is on screen, since the chat is pointing at no single
// conversation, not the run's own session cards.
// Reads the panel's own predicate (showingRunGraph), not the mode alone, since a followed run can show its diagram too;
// only on a wide chat surface, since the docked panel always shows the focused chat.
const runGraphUp = computed(
    () =>
        chatWide.value &&
        showingRunGraph(
            workflowRuns.value.find((run) => run.runId === chatRun.value?.runId),
            chatRun.value,
            chatStrip.value.panes,
        ),
);
// Reads the app-wide chat strip (useChat.chatStrip), never this window's own tab list, which is a stale shadow once the
// chat is popped out.
const highlightId = computed(() => flashId.value ?? (mobile.value || runGraphUp.value ? undefined : chatStrip.value.active));
// Other panes get a fainter ring than the focused one, since a split is not a ranking, just chats read side by side.
// Tied to `highlightId`'s own conditions (mobile, run graph), not the pane set alone, so the same two states clear
// both.
const inPane = (id: string): boolean => {
    const { panes: shown } = chatStrip.value;
    return !mobile.value && !runGraphUp.value && shown.length > 1 && shown.includes(id);
};
// Whether the chat is open only as a look (TabFacts.peek), read off the strip like the ring; desktop only, since a
// phone's tab set is one deep.
const peeked = (id: string): boolean => !mobile.value && chatStrip.value.tabs.some((tab) => tab.id === id && tab.peek);
const finishedWindow = computed(() => windowFinished(boardLanes.value.finished, windowed.value ? highlightId.value : undefined, (agent) => agent.id));
// Finished shows its window, or the archive when open; the other two lanes show everything. A filter lifts Finished's
// window, since a result set must not hide some of its own matches.
// The archive keeps its own page under a filter instead, since its pile is unbounded; nothing is hidden, the tail row
// just says how much more there is.
const cardsFor = (lane: FleetLane): FleetAgent[] => {
    if (lane === `finished` && archiveOpen.value) {
        return archiveRows.value.slice(0, archiveShown.value);
    }
    const source = lane !== `finished` ? boardLanes.value[lane] : windowed.value ? finishedWindow.value.shown : boardLanes.value.finished;
    return filtering.value ? source.filter(matches) : source;
};
// Rows the filter kept, not rows drawn: the archive draws only a page of its matches, so counting cards would report
// the pager's state as the search's answer.
const keptIn = (lane: FleetLane): number =>
    (lane === `finished` && archiveOpen.value ? archiveRows.value.length : cardsFor(lane).length) + runsFor(lane).length;
// The "n of m" on a lane header; the denominator is the lane, not the window, since the window is lifted anyway while
// filtering.
// A run counts as the one row it is on both sides, or a workflow's match could leave the lane reading 0 of 3 with the
// run visible underneath.
const laneCount = (lane: FleetLane): string => {
    const held =
        archiveOpen.value && lane === `finished`
            ? archiveSize.value
            : boardLanes.value[lane].length + runsInLane(boardRunRows.value, lane, Number.POSITIVE_INFINITY, needingYou.value).length;
    return filtering.value ? `${keptIn(lane)} of ${held}` : `${held}`;
};
// What the tail row collapses: the window's own count, plus the runs the same window capped, since a hidden run hides
// its steps with it.
const hiddenRuns = computed(
    () => runsInLane(liveRuns.value, `finished`, Number.POSITIVE_INFINITY, needingYou.value).length - runsFor(`finished`).length,
);
const hiddenFinished = computed(() => finishedWindow.value.hidden + hiddenRuns.value);
// What a query found off the board: archived agents and conversations no agent owns; otherwise a filter answers
// "nothing" for a hit one click away.
// Steps stay excluded: the archived run row they belong to already lists them.
const archivedHits = computed(() => archivedMatches.value.filter((agent) => !insideRun(agent, ledgerRunIds.value)));
const beyondCount = computed(() => archivedHits.value.length + sessionMatches.value.length);
// Suppressed while the archive is the Finished column, since those cards are already on screen there.
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
// A never-carded conversation opens as an ordinary tab; the board itself is outside the panel, so the open is a summons
// to every window.
const openSession = (id: string): void => {
    const conversationId = uuid();
    summonChat({
        kind: `reveal`,
        verb: `show`,
        entries: [{ conversationId, sessionRef: id, title: sessionMatches.value.find((session) => session.id === id)?.title }],
        focus: conversationId,
        caret: false,
    });
};
// What the board tells a screen reader, since neither visual report (the counter pulse, the receipt pill) conveys
// anything on its own.
const announcement = ref(``);
// The board's one irreversible action, so it's the one that stops and asks; sits in the archive header's slot Finished
// uses for Clear (same position, opposite weight).
// Bulk-only, never per-card: a per-card delete would sit a pixel from Restore on the same hover row; a single agent's
// Discard lives on its review panel instead, beside its diff.
// The dialog names the branch count and says what survives, since the archive's whole promise up to that point is
// "nothing is lost".
const pendingPurge = ref(false);
const purging = ref(false);
// Whether THIS visit emptied the archive: an empty list otherwise reads as "nothing archived yet", a lie to someone who
// just deleted twelve agents.
const purged = ref(false);
const confirmPurge = async (): Promise<void> => {
    pendingPurge.value = false;
    purging.value = true;
    const aimedAt = archived.value.length;
    try {
        await purgeArchived();
        purged.value = true;
        // The one report here that can't be re-derived from anything on screen, since what it's about is now gone.
        announcement.value = `${aimedAt - archived.value.length} archived agents deleted`;
    } finally {
        purging.value = false;
    }
};
const toggleArchive = async (): Promise<void> => {
    archiveOpen.value = !archiveOpen.value;
    purged.value = false;
    if (archiveOpen.value) {
        // Resets to one page on every opening, so the door costs the same the tenth time as the first.
        archiveShown.value = ARCHIVE_PAGE;
        await loadArchived();
    }
};
/* --- Saying that an archive happened -------------------------------------------------------------------- */
// A sweep's receipt is raised by the store and drawn by the app's one shared notification lane
// (shell/NotificationHost.vue), including its dwell, hover-pause, and Undo.
// The archive counter is the whole receipt for a single card: long enough to catch the eye following the card out of
// the lane, short enough to read as a move, not a new state.
const PULSE_MS = 1_100;
const pulsing = ref(false);
let pulseTimer: ReturnType<typeof setTimeout> | undefined;
// One archive, one reaction: the pulse and the screen-reader line are the same event said twice from one place, not two
// watchers.
watch(archivedFlash, () => {
    pulsing.value = true;
    clearTimeout(pulseTimer);
    pulseTimer = setTimeout(() => (pulsing.value = false), PULSE_MS);
    announcement.value = `${undoable.value.length} agent${undoable.value.length === 1 ? `` : `s`} archived`;
});
// Another surface can hand off a just-started agent via /agents?focus=<id> for the board, not the drill-in, since a
// fresh turn has no diff yet to review.
// The id can arrive before its card does, so a watcher (not a mount-time read) resolves once the fleet has the agent;
// one-shot, so a reload or Back doesn't re-focus a card the user has since moved off.
// Mirrors a click (dock points at it, ring, marks read, scrolls into view) and additionally opens whatever's hiding the
// card (a filter, the archive); the Finished window instead keeps the selected card by itself.
const FOCUS_FLASH_MS = 4_000;
let flashTimer: ReturnType<typeof setTimeout> | undefined;
const cardEls = new Map<string, HTMLElement>();
// AgentCard is a component, so the ref returns its instance, not an element; `$el` is its root div.
const setCardEl = (id: string, el: unknown): void => {
    const root = (el as { $el?: unknown } | null)?.$el;
    if (root instanceof HTMLElement) {
        cardEls.set(id, root);
    } else {
        cardEls.delete(id);
    }
};
// Awaited, since the card may not be rendered on the tick it's asked for (the window pins it, the focus flow uncovers
// it); `nearest` leaves an already-visible card alone.
const revealCard = async (id: string): Promise<void> => {
    await nextTick();
    cardEls.get(id)?.scrollIntoView({ block: `nearest` });
};
// A selection made off the board (a chat tab, History) scrolls the board to match, since a ring outside the scrollport
// looks like the click did nothing.
// A selection made on the board scrolls nothing: `selectedHere` marks it so this watch stands down.
let selectedHere: string | undefined;
watch(highlightId, (id) => {
    // Consumed on sight: the mark is about the one selection just made, not a standing claim, or a card clicked once
    // would never scroll again from elsewhere.
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
        // Uncovers the card: the filter and archive are lifted by hand, but the Finished window only lifts itself where
        // a ring exists to pin the card.
        // On a phone the ring vanishes with the flash, so the window would close over the very card the link was for;
        // there, the whole lane opens instead.
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
        // Called explicitly, not via the selection watch above: a link may name the agent the dock already points at,
        // so the ring never moves for that watch to catch.
        await revealCard(agent.id);
    },
    { immediate: true },
);
// Undo also lives on Mod+Z, since an archive that says nothing has to be reversible by reflex; the `when` gate hands it
// back whenever there's nothing to undo or a field owns its own undo.
const undoShortcut = computed(() => commandShortcut(`agents.undoArchive`));
let boardCommands: readonly Disposable[] = [];
// One class string per state, not composed flags, since two ring widths or min-heights in one list would resolve by
// Tailwind's emit order, not by intent.
const laneDropClass = (lane: FleetLane): string => {
    if (!dragging.value) {
        return ``;
    }
    // The archive has no `data-drop` while it occupies the Finished column, since it isn't a lane and must not
    // advertise being one.
    if (!accepts(lane) || (lane === `finished` && archiveOpen.value)) {
        return `min-h-24 opacity-40`;
    }
    return over.value === lane ? `min-h-24 bg-primary-600/5 ring-2 ring-primary-500/60` : `min-h-24 ring-1 ring-line-strong/60`;
};
// What the ghost promises over a target: the action's verb, or the reason there isn't one.
const hint = computed(() => {
    if (action.value !== undefined) {
        return dropActionLabel(action.value);
    }
    if (dragged.value === undefined || over.value === undefined) {
        return `Drop on a lane to act`;
    }
    return dropRejection(dragged.value, over.value);
});
// A shared width measurement (useNarrow), not a CSS container query: `container-type` would make this a containing
// block for the fixed-position drag ghost, breaking its viewport coordinates.
const NARROW_BOARD_REM = 48;
const boardEl = ref<HTMLElement | undefined>(undefined);
const narrow = useNarrow(boardEl, NARROW_BOARD_REM);
onMounted(() => {
    void refresh();
    // Worth the one request at mount: without a count, Finished can only offer an archive the user has no reason to
    // believe holds anything.
    void loadArchived();
    boardCommands = [
        // Published only while the board is mounted, so Mod+Z hands itself back the moment the fleet leaves the screen.
        publishContextKey(
            `agentsUndoable`,
            computed(() => undoable.value.length > 0),
        ),
        registerCommand({
            owner: `builtin`,
            command: `agents.undoArchive`,
            title: `Undo Archive`,
            icon: `history`,
            keybinding: `Mod+Z`,
            when: `agentsUndoable && !editableTarget`,
            handler: undoArchive,
        }),
        // An accelerator, not the only way in, since the field is already on the header; deliberately unbound, since
        // Mod+F belongs to the browser and this registry is global to every window the app owns.
        // A binding claimed while this board is mounted would swallow Mod+F in the floating chat too, where the board
        // isn't even on screen.
        registerCommand({
            owner: `builtin`,
            command: `agents.filter`,
            title: `Filter Agents…`,
            icon: `search`,
            // Focus and select, so a chord typed over a stale query starts fresh instead of needing the old text
            // cleared first.
            handler: () => filterField.value?.focus(true),
        }),
    ];
});
onUnmounted(() => {
    clearTimeout(pulseTimer);
    clearTimeout(flashTimer);
    for (const disposable of boardCommands) {
        disposable.dispose();
    }
    boardCommands = [];
});
const LANES: readonly { key: FleetLane; label: string; dot: string; empty: string }[] = [
    { key: `attention`, label: `Attention`, dot: `bg-warning`, empty: `Nothing needs you right now.` },
    { key: `active`, label: `Active`, dot: `bg-success`, empty: `No agents working. Start one and delegate.` },
    { key: `finished`, label: `Finished`, dot: `bg-line-strong`, empty: `Finished agents land their work in your workspace.` },
];
// The board's own total counts what's on screen: a run's steps count once, as their row, not again beside it.
// Held wakes count toward having something to show, so a fresh workspace with only a hold doesn't hide behind the
// empty-board splash.
const total = computed(
    () => LANES.reduce((sum, lane) => sum + boardLanes.value[lane.key].length, 0) + boardRunRows.value.length + heldWakes.value.length,
);
// A different question from `total`: whether anything has EVER happened here, which is what the first-run screen turns
// on. A never-registered conversation is a `draft` card, and an untouched draft doesn't count as started.
// Anything else does, archive included: agents that ran and were filed away are a history, not an empty workspace.
const started = computed(
    () =>
        LANES.reduce((sum, lane) => sum + boardLanes.value[lane.key].filter((agent) => agent.status !== `draft`).length, 0) +
            boardRunRows.value.length +
            heldWakes.value.length +
            archiveSize.value >
        0,
);
// Summed over the same cardsFor/runsFor the lanes render, so the header tally can never disagree with the counts under
// it.
const kept = computed(() => LANES.reduce((sum, lane) => sum + keptIn(lane.key), 0));
// Must not claim more than it knows: "n of 40" asserts all forty were checked, which is false while the daemon's half
// of the filter is still outstanding.
// While the answer is partial, the tally says so instead of counting, so a half-finished search isn't mistaken for a
// complete one.
const matchTally = computed(() => (searchPartial.value ? `searching the rest…` : `${kept.value} of ${total.value}`));
// The filter's own empty state (agents exist, none matched), distinct from an empty fleet; never true while the answer
// is still partial.
const noMatches = computed(() => filtering.value && !searchPartial.value && !archiveOpen.value && kept.value === 0 && beyondCount.value === 0);
// "Clear" only appears when it would do something; Finished holds exactly the archivable set by construction.
const clearable = computed(() => lanes.value.finished.length);

// Asks for a task; it is not a second composer (there is exactly one composer in the app, the chat) and it no longer
// shows a sign-in wall when nothing can send (that used to read as a broken sign-in or a paywall).
// A suggestion fills the composer for the user to edit and send, it never sends itself.
// Suggestions are about work with no code yet (building something): getting existing code in is the workspace pane's
// job, not this board's.
// Workspace facts the suggestions turn on, already fetched for the rail elsewhere; the board adds no fetch of its own.
const { panels: workspaceRepos } = usePanels();
const workspaceChanges = useChanges();
// Whether there's anything to work ON: repos, or uncommitted changes (files dropped in without a git of their own still
// count).
const hasWork = computed(() => workspaceRepos.value.length > 0 || workspaceChanges.count.value > 0);
// Concrete sentences to press, not feature names ("Explain this codebase", not "code understanding"); phrased as a
// ladder: understand, then a small safe change with a stop before anything's written.
const starters = computed<readonly { readonly label: string; readonly prompt: string }[]>(() => {
    // Nothing to point an agent at yet, so only the one task needing no code is offered: build something and get a
    // public link (lands in the outbox, shown as the Preview area's Public site target).
    if (!hasWork.value) {
        return BUILD_IDEAS.map((example) => ({ label: example.label, prompt: buildPrompt(example.idea) }));
    }
    return [
        // Uncommitted work leads the list when it exists, since it's the most urgent thing on a workspace that has any.
        ...(workspaceChanges.count.value > 0
            ? [{ label: `Review my changes`, prompt: `Review my uncommitted changes and flag anything risky before I commit them.` }]
            : []),
        {
            label: `Explain this codebase`,
            prompt: `Explain this codebase, what it does, where the entry points are, and which files I should read first.`,
        },
        {
            label: `Find something to improve`,
            prompt: `Suggest three small, safe improvements to this codebase. Wait for me to choose one before you change anything.`,
        },
    ];
});
// A card click focuses, it doesn't navigate: on desktop it only points the chat dock (and every window's floating chat)
// at the agent and rings the card.
// Cheap and reversible, so clicking down a lane is skimming; the review detail is a separate, deliberate act
// (reviewAgent). Mobile has no dock, so a tap there navigates instead.
// Same gestures as the chat rail's tab list (ChatTabList.onRowClick): at N panes, what's selected IS what's on screen,
// so picking a card here gives that chat a column there.
// Alt (not bare Ctrl) means "in addition", since Ctrl+click is macOS's secondary click and a card is also a drag
// source; Ctrl/Cmd and Shift work too, for muscle memory from the strips.
// An unmodified click is the reset: it collapses any split, since a selection you can't replace by clicking elsewhere
// isn't one. Every gesture here is a summons, since the panel it composes may be another window's.
const paneOrder = computed<FleetAgent[]>(() => LANES.flatMap((lane) => cardsFor(lane.key)));
const paneAnchor = ref<string>();
const summonCards = (verb: `show` | `beside` | `panes`, cards: readonly FleetAgent[], focus: string): void => {
    summonChat({ kind: `reveal`, verb, entries: cards.map((card) => agentTabOf(agentSeed(card))), focus, caret: false });
    for (const card of cards) {
        markSeen(card.id);
    }
};
const paneGesture = (agent: FleetAgent, event: MouseEvent): boolean => {
    if (event.shiftKey) {
        const order = paneOrder.value;
        const from = order.findIndex((card) => card.id === (paneAnchor.value ?? chatStrip.value.active));
        const to = order.findIndex((card) => card.id === agent.id);
        const run = from === -1 ? [agent] : order.slice(Math.min(from, to), Math.max(from, to) + 1);
        summonCards(`panes`, run, agent.id);
        return true;
    }
    if (!event.altKey && !event.ctrlKey && !event.metaKey) {
        return false;
    }
    paneAnchor.value = agent.id;
    // Ctrl/Cmd toggles a pane; Alt only ever adds, which is what makes Alt the safe one-shot gesture.
    if ((event.ctrlKey || event.metaKey) && !event.altKey && chatStrip.value.panes.includes(agent.id) && chatStrip.value.panes.length > 1) {
        summonChat({ kind: `reveal`, verb: `unpane`, entries: [], focus: agent.id, caret: false });
        return true;
    }
    summonCards(`beside`, [agent], agent.id);
    return true;
};

const focusAgent = (agent: FleetAgent, event?: MouseEvent): void => {
    // A drag's pointerup arrives here as a click on the card it started from; it must not also open the agent.
    if (consumeSuppressedOpen()) {
        return;
    }
    // A click on a card from another box opens its review instead of doing nothing, since pointing the docked chat at
    // it (the normal click) can't work across sandboxes.
    // The crossing that would let you talk to it lives on that page instead.
    if (isRemote(agent)) {
        reviewAgent(agent);
        return;
    }
    // The user is pointing the board somewhere themselves, so whatever a deep link was highlighting is over.
    flashId.value = undefined;
    // This board made the selection itself, so the reveal watch must not also scroll to it.
    selectedHere = agent.id;
    // The click itself, before anything downstream can move it: the head of the focus trace (focusTrace.ts).
    traceFocus(`board-click`, { id: agent.id, status: agent.status });
    // A modified click asks for a column, not focus, and says so itself; desktop only, since panes live in the floating
    // window and mobile just navigates.
    if (event !== undefined && !mobile.value && paneGesture(agent, event)) {
        return;
    }
    paneAnchor.value = agent.id;
    // An unmodified click is the reset those modifiers are defined against: `show` collapses any split, and the split
    // is one Alt+click away again (the rail keeps the rest).
    // Also a look (useAgents.open's peek mode): the tab is the reader's only while they're reading it, and closes on
    // the next card; anything they do in it keeps it (Conversation.keep).
    open(agent, `peek`);
    if (mobile.value) {
        void router.push(`/agents/${encodeURIComponent(agent.id)}`);
    }
};
// The deliberate view-change: focuses the dock AND swaps to the review detail; only offered for a registered agent, so
// there's always a detail to land on.
const agentHref = (agent: FleetAgent): string =>
    router.resolve(
        isRemote(agent)
            ? { path: `/agents/${encodeURIComponent(agent.id)}`, query: { sandbox: agent.sandboxId } }
            : `/agents/${encodeURIComponent(agent.id)}`,
    ).href;
// Keeps a chat this board only opened for a look. A summons, like the close below: the tab lives in whichever window is
// drawing the chat, often not this one.
// Promoted locally alone, a popped-out chat would sweep the tab on its next focus move, losing exactly the thing this
// press meant to keep.
const keepAgent = (agent: FleetAgent): void => {
    summonChat({ kind: `keep`, conversationIds: [agent.id] });
};

const reviewAgent = (agent: FleetAgent): void => {
    // A card from another box opens its review without minting a tab, since `open()` files into the chat singleton
    // pointed at THIS daemon, which has never heard of that agent.
    // The review page reads `?sandbox=` instead and addresses that box directly.
    if (isRemote(agent)) {
        void router.push({ path: `/agents/${encodeURIComponent(agent.id)}`, query: { sandbox: agent.sandboxId } });
        return;
    }
    open(agent);
    // Walking to the agent's own page is a decision about it, not a glance, so a tab a click opened for a look stops
    // being one.
    keepAgent(agent);
    void router.push(`/agents/${encodeURIComponent(agent.id)}`);
};
// The only exit for a card with no registry entry: closes the conversation itself (not `archive`, since there's nothing
// daemon-side to file).
// Differs from the chat rail's ×: the rail only removes a chat from its own operating surface (words set aside, card
// stays); the board's × ends the conversation everywhere, words and all, in one press.
// A summons, like every gesture here, since the chat this closes may live in another window's floating panel.
const closeAgent = (agent: FleetAgent): void => {
    summonChat({ kind: `close`, conversationIds: [agent.id] });
};

// One shared menu (like the chat rail's tab menu) for every card, so forty cards cost one node and only one is ever
// open.
// Exists because a card's surface is otherwise all press-and-drag, so occasional actions (the session name used to be a
// small button, mis-hit constantly) need somewhere else to live.
// Adds no new actions, only a place to find the ones the card already offers, including glyphs that only appear on
// hover.
const cardMenu = ref<{ show: (event: Event) => void } | undefined>();
const menuAgent = ref<FleetAgent>();

// Copies through the pressed card's own document (clipboardOf), not this module's `navigator`, so the app's clipboard
// accessor asks the element the gesture happened in.
const menuAnchor = ref<Element>();
const copySessionName = async (branch: string): Promise<void> => {
    try {
        await clipboardOf(menuAnchor.value).writeText(branch);
    } catch {
        // Clipboard may be unavailable (insecure context); the name is still on the card either way.
    }
};

// Groups, not a flat list with inline separators: almost every row is conditional, so a separator written inline would
// draw a line under a group that turned out empty.
// No longer the only way off a watch: the card's own readout carries that press now, beside the fact it's about.
// Stays here for the verb+count form ("Stop watching (3)"), which the card has no room for beside its own truncating
// note.
// One row for however many are armed, since the daemon disarms them together (agents.stopWatching).
// Stops a chat opened for a look from going (`peeked`, mirrors AgentCard's pin); a row-builder like the two below, so
// the menu stays a list of groups.
const keepRow = (agent: FleetAgent): MenuItem[] => (peeked(agent.id) ? [{ label: `Keep Open`, icon: `pin`, command: () => keepAgent(agent) }] : []);

const watchRow = (agent: FleetAgent, here: boolean): MenuItem[] => {
    const armed = agent.watches?.length ?? 0;
    if (!watching(agent) || !here) {
        return [];
    }
    return [{ label: armed === 1 ? `Stop watching` : `Stop watching (${armed})`, icon: `eye`, command: () => void stopWatching(agent.id) }];
};

// Filing away, restoring, or closing a never-registered card: the first two are the active box's alone (write through
// the fleet store); the third is just this browser's tab.
const filingRow = (agent: FleetAgent, here: boolean): MenuItem[] => {
    const filing = !here
        ? []
        : agent.archivedAt !== undefined
          ? [{ label: `Restore`, icon: `history`, command: () => restore([agent.id]) }]
          : canArchive(agent)
            ? [{ label: `Archive`, icon: `box`, command: () => archive([agent.id]) }]
            : [];
    return [...filing, ...(unregistered(agent.status) ? [{ label: `Close`, icon: `times`, command: () => closeAgent(agent) }] : [])];
};

const cardMenuItems = computed<MenuItem[]>(() => {
    const agent = menuAgent.value;
    if (agent === undefined) {
        return [];
    }
    const review = mobile.value ? undefined : reviewAction(agent);
    const branch = agent.branch;
    // What a remote card's menu can offer: opening, reviewing and copying its session name work at a distance; ending a
    // watch, archiving and restoring don't, since those write through the active daemon's own roster.
    // Dropped rather than shown disabled: a menu of greyed-out verbs teaches nothing; the review page (this menu's own
    // second row) carries the crossing that reaches them.
    const here = !isRemote(agent);
    const groups: MenuItem[][] = [
        [
            { label: `Open`, icon: `arrow-right`, command: () => focusAgent(agent) },
            // For a card whose chat is open only as a look, the press that stops it going; the chat rail's menu carries
            // the identical row for the identical state.
            ...keepRow(agent),
            // The agent's page has an address, so this row is also a link: hoverable, and Ctrl/Cmd-clickable into its
            // own tab; a plain click still goes through `reviewAgent`, which also points the chat dock.
            ...(review === undefined ? [] : [{ label: review, icon: `copy`, url: agentHref(agent), command: () => reviewAgent(agent) }]),
        ],
        // Hands over the branch, which is what the card prints; the name's other forms are already labelled on the
        // agent's own page.
        branch === undefined ? [] : [{ label: `Copy session name`, icon: `code`, command: () => void copySessionName(branch) }],
        // The crossing to another box, named after the destination rather than called "Switch": it's the one press here
        // that costs the whole shell (chat, tree, every extension), so it says where it's taking you first.
        // Also here, not just on the review page, since this menu is where the board keeps decisions made ABOUT a card.
        here || agent.sandboxId === undefined
            ? []
            : [
                  {
                      label: `Open in ${boxNameOf.value.get(agent.sandboxId) ?? `its sandbox`}`,
                      icon: `arrow-right`,
                      command: () => openInSandbox(agent.sandboxId!, agent.id),
                  },
              ],
        watchRow(agent, here),
        filingRow(agent, here),
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
// A run is not an agent (see WorkflowRunCard), so it's a second list rendered into the same lanes rather than a `fleet`
// row; it sits atop its lane, since a container belongs above its own contents.
// Finished caps runs at the same window as agents and offers no "show earlier" of its own; run history lives on the
// workflows page instead.
const openRunGraph = (run: WorkflowRun): void => {
    void router.push({ name: `extension`, params: { ext: `workflows` }, query: { run: run.runId } });
};

// Opens the run's sessions in the chat panel, one column each (shared with the rail's row so the two doors can't
// drift); does not navigate, since several live transcripts is what a person actually wants from a running workflow.
const openRun = (run: WorkflowRun): void => void openRunInChat(run);

// Runs asked to stop but not yet settled: the abort reaches every turn at once, but the ledger only confirms once each
// step unwinds, which is on a poll; without this mark a stop looks untouched until then.
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
        // Usually means it ended between render and press; either way, a stop that didn't take must not leave the card
        // stuck disabled.
        forgetStopping(run.runId);
    }
};
// Files an ended run away, sessions and all, with no confirmation: archiving is lossless and the way back is the
// archive itself.
const archiveRun = async (run: WorkflowRun): Promise<void> => {
    await archiveWorkflowRun.mutateAsync(run.runId).catch(() => undefined);
};
const restoreRun = async (run: WorkflowRun): Promise<void> => {
    await unarchiveWorkflowRun.mutateAsync(run.runId).catch(() => undefined);
};
// Held until the ledger says the run has actually stopped, not until the request returns, since in-flight steps keep
// finishing for minutes after the ask.
watch(workflowRuns, (list) => {
    for (const runId of stoppingRuns.value) {
        if (list.find((run) => run.runId === runId)?.state !== `running`) {
            forgetStopping(runId);
        }
    }
});

// The approvals queue's rows, Attention lane only: a hold means only "waiting on you", with no conversation yet to
// place elsewhere.
// Releasing is detached daemon-side, so the row leaves on an optimistic remove; `busyHeld` covers the gap so a slow
// answer can't collect two presses.
const busyHeld = ref(new Set<string>());
const releaseWake = async (id: string, verb: `approve` | `reject`): Promise<void> => {
    busyHeld.value = new Set([...busyHeld.value, id]);
    try {
        await releaseHeld(id, verb);
    } catch {
        // Usually the countdown or another device beat this press to it; refresh repaints the truth either way.
        void refresh();
    } finally {
        const rest = new Set(busyHeld.value);
        rest.delete(id);
        busyHeld.value = rest;
    }
};

// A filtered board is a result set wearing the lanes' shape, so it doesn't drag: half the lanes may read "no matches"
// and a drop would act on a lane the user isn't really seeing.
const grabCard = (event: PointerEvent, agent: FleetAgent, card: HTMLElement): void => {
    if (filtering.value) {
        return;
    }
    begin(event, agent, card);
};
</script>
<template>
    <!--
        `relative` positions the lane-drop affordances only; the fixed drag ghost and the app's notification lane need
        no containing block here.
    -->
    <div ref="boardEl" class="relative flex h-full min-h-0 flex-col">
        <!--
            Wraps rather than shrinking controls: the filter field is permanent and /agents can be squeezed to a few
            hundred pixels by the chat panel's drag handle.
            Field sits on equal flex-1 basis-0 flanks so it's the bar's true center, not a leftover space; below the
            lane-stacking width the field takes its own row and the flanks keep the first one.
            `.view-header .view-header-wrap` (styles.css): this is the board's bar in the app's top row — the one line
            across the window, the height every other bar has, and inside the desktop app the title bar itself.
        -->
        <div class="view-header view-header-wrap flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line px-3 py-1">
            <div class="flex min-w-0 flex-1 basis-0 items-center gap-2">
                <!--
                    Drawn only when more than one sandbox exists (scopeOffered): a switch whose two settings look
                    identical teaches the reader to ignore controls.
                -->
                <SegmentedControl v-if="scopeOffered" v-model="fleetScope" :options="SCOPE_OPTIONS" class="shrink-0" />
            </div>
            <SearchBar
                ref="filterField"
                v-model="query"
                v-model:match-case="matchCase"
                variant="field"
                clearable
                :busy="searching"
                aria-label="Filter agents by your messages"
                placeholder="Filter by your messages…"
                class="mx-auto max-w-full shrink-0"
                :class="narrow ? 'order-last basis-full' : 'w-72'"
            />
            <div class="flex min-w-0 flex-1 basis-0 items-center justify-end gap-2">
                <!--
                    Shown only while filtering, since unfiltered lane headers already carry their own counts; says
                    "searching" rather than a number while the answer is partial.
                -->
                <span v-if="filtering" class="shrink-0 text-2xs text-muted" :aria-busy="searchPartial">{{ matchTally }}</span>
                <!--
                    Appears exactly when two or more chats sit side by side (the panes are the selection); opens a
                    draft composed from their transcripts but not sent.
                -->
                <Button v-if="panes.length >= 2" size="small" severity="secondary" :disabled="synthesizing" class="shrink-0" @click="synthesize">
                    <Icon :name="synthesizing ? `spinner` : `sparkles`" :spin="synthesizing" />Synthesize {{ panes.length }}
                </Button>
                <Button size="small" class="shrink-0" @click="startAgent()"> <Icon name="plus" />New agent </Button>
            </div>
        </div>
        <!--
            Failures only: the layout shift and dismissal this costs suit something the user must read, not a routine
            action's receipt (which floats instead).
        -->
        <p v-if="notice !== undefined" class="flex shrink-0 items-center gap-2 border-b border-line bg-danger/10 px-3 py-1.5 text-2xs text-danger">
            <Icon name="exclamation-triangle" class="shrink-0 text-2xs" />
            <span class="min-w-0 flex-1">{{ notice }}</span>
            <button type="button" aria-label="Dismiss" class="shrink-0 rounded p-0.5 hover:bg-overlay" @click="dismissNotice">
                <Icon name="times" class="text-2xs" />
            </button>
        </p>
        <!--
            What the counter's pulse can't tell a screen reader; covers every archive so the visual pill stays purely
            visual.
        -->
        <span class="sr-only" aria-live="polite">{{ announcement }}</span>
        <!--
            Nothing on the board AND nothing archived is the only true empty state; an archive behind it would
            otherwise be a dead end with no door to it.
        -->
        <div v-if="(!started || total === 0) && !archiveOpen" class="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-4 text-center">
            <!--
                One heading, one sentence, nothing waiting on a daemon read: it used to swap its lower half once
                accounts loaded, which is how it came to flash a sign-in wall right after signup.
            -->
            <template v-if="!started">
                <div class="flex w-full max-w-xl flex-col gap-2">
                    <h2 class="text-sm font-semibold text-content">Start your first agent</h2>
                    <p class="text-2xs text-muted">
                        Agents work on their own branch while you carry on: you review what they did before anything lands in your workspace.
                    </p>
                </div>
            </template>
            <!--
                A board that's been cleared, not a first run: this user knows what agents are and just needs the way
                back to the archive.
            -->
            <template v-else>
                <Icon name="sparkles" class="text-3xl text-subtle" />
                <p class="max-w-sm text-xs text-muted">
                    Nothing on the board. Start a conversation here or in the workspace; both appear on this board, and isolated work remains
                    reviewable on its own branch.
                </p>
            </template>
            <!--
                Tasks read off the actual workspace (see `starters`), filling the composer rather than dispatching, so
                the user sends their own first turn; empty when the workspace is.
            -->
            <div v-if="!started && starters.length > 0" class="flex max-w-xl flex-wrap items-center justify-center gap-1.5">
                <button v-for="starter in starters" :key="starter.label" type="button" class="ui-chip" @click="composeAgent(starter.prompt)">
                    {{ starter.label }}
                </button>
            </div>
            <!-- Carries the pulse too, since it's the only archive affordance left once the board itself is bare. -->
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
        <!--
            No padding of its own: the stacked board's sticky lane headers pin to top-0, and padding would leave a gap
            above them. One of the few `.scrollbar-stable` boxes, since a lane filling past the fold is ordinary here.
        -->
        <div v-else class="scrollbar-thin scrollbar-stable min-h-0 flex-1 overflow-auto">
            <!--
                `content-start` stops the stacked grid's rows from stretching to fill `h-full`, which would otherwise
                float a lane's cards above the next header.
                Exception: a query matching nothing drops `h-full`, so the explanation isn't pushed below the fold.
            -->
            <div
                class="grid gap-3.5 p-3.5 sm:gap-4 sm:p-4"
                :class="[narrow ? 'content-start' : 'grid-cols-3 items-start lg:gap-6 lg:p-6', noMatches ? '' : 'h-full']"
            >
                <section
                    v-for="lane in LANES"
                    :key="lane.key"
                    :data-drop="lane.key === 'finished' && archiveOpen ? undefined : lane.key"
                    class="flex min-w-0 flex-col rounded-xl transition-colors"
                    :class="[!dragging && !narrow ? 'min-h-0' : '', laneDropClass(lane.key)]"
                >
                    <!--
                        Finished's header doubles as the archive's window, swapping its dot/label and growing a way
                        back; pinned while scrolling stacked, so a card off-screen from its header can't be misread.
                        Height is the row's, not its own contents': Finished carries extra controls (the archive
                        counter, Clear), and a header that sizes to its own content would make lanes uneven and
                        misaligned.
                    -->
                    <header class="flex h-8 shrink-0 items-center gap-2.5 px-1" :class="narrow ? 'sticky top-0 z-10 rounded-t-xl bg-canvas' : ''">
                        <template v-if="lane.key === 'finished' && archiveOpen">
                            <button
                                type="button"
                                aria-label="Back to finished agents"
                                v-tooltip.bottom="'Back to finished'"
                                :class="ui.iconButton(`h-4 w-4 rounded`)"
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
                            <!--
                                "3 of 12" while filtering: which lane a match sits in is half the answer, so lanes stay
                                and report their own share on screen.
                            -->
                            <span class="rounded-full bg-overlay px-1.5 py-px text-2xs text-muted">{{ laneCount(lane.key) }}</span>
                        </template>
                        <span class="flex-1"></span>
                        <template v-if="lane.key === 'finished' && !archiveOpen">
                            <!--
                                The receipt for a quiet archive: the counter is where the card went, so a fading
                                highlight there acknowledges it; the old repeated reassurance now lives once, on this
                                button's tooltip.
                            -->
                            <button
                                v-if="archiveSize > 0"
                                type="button"
                                :aria-label="`Open the archive (${archiveSize})`"
                                v-tooltip.bottom="'Taken off the board: branches and conversations are kept'"
                                class="ui-chip shrink-0 gap-1 px-1 py-px"
                                :class="pulsing ? `ui-chip-on ring-1 ring-primary-500/50` : ``"
                                @click="toggleArchive"
                            >
                                <Icon name="history" class="text-2xs" />{{ archiveSize }}
                            </button>
                            <!--
                                Hidden while filtering, like the drag: Clear archives the WHOLE lane, which isn't the
                                right scope above a lane reading "1 of 12".
                            -->
                            <Button
                                v-if="clearable > 0 && !filtering"
                                size="small"
                                severity="secondary"
                                :text="true"
                                class="shrink-0"
                                aria-label="Archive every finished agent"
                                v-tooltip.bottom="`Archive all ${clearable}: you can undo it`"
                                @click="archive()"
                            >
                                Clear
                            </Button>
                        </template>
                        <!--
                            Same slot as Clear, opposite weight: danger only on hover, so a column of retired agents
                            doesn't read as a hazard while browsing it (the dialog is the actual guard).
                            Hidden while filtering, like Clear: this deletes the WHOLE archive, not the scope shown on
                            screen.
                            Counts conversations, not rows: a workflow row is one thing to browse but four transcripts
                            to destroy, and that's the number an irreversible act should show.
                        -->
                        <Button
                            v-if="lane.key === 'finished' && archiveOpen && archiveSize > 0 && !filtering"
                            size="small"
                            severity="danger"
                            :text="true"
                            class="shrink-0"
                            :aria-label="`Delete all ${archived.length} archived agents permanently`"
                            :disabled="purging"
                            v-tooltip.bottom="`Delete all ${archived.length} permanently: branches and all. This can't be undone.`"
                            @click="pendingPurge = true"
                        >
                            <Icon :name="purging ? 'spinner' : 'trash'" :spin="purging" class="text-2xs" />Delete all
                        </Button>
                    </header>
                    <!--
                        Held wakes lead the lane, since a hold is wholly waiting on the user, more than anything
                        running below it; Attention lane only.
                    -->
                    <div v-if="lane.key === 'attention' && !archiveOpen && heldWakes.length > 0" class="flex flex-col gap-2.5 pb-2.5">
                        <HeldWakeCard
                            v-for="entry in heldWakes"
                            :key="entry.id"
                            :entry="entry"
                            :busy="busyHeld.has(entry.id)"
                            @approve="releaseWake(entry.id, `approve`)"
                            @reject="releaseWake(entry.id, `reject`)"
                        />
                    </div>
                    <!--
                        Runs sit above their lane's agent cards, since a run is a container of several of them and a
                        container belongs above its contents, not among them.
                        In the archive, archived runs list here in the same slot; their steps have no separate cards
                        there either.
                    -->
                    <div v-if="runsFor(lane.key).length > 0" class="flex flex-col gap-2.5 pb-2.5">
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
                        class="px-1 pb-3 text-2xs text-subtle"
                    >
                        {{
                            purged
                                ? "Archive emptied. Finished agents will collect here again on their own after a few quiet days."
                                : "Nothing archived yet. Finished agents land here on their own after a few quiet days."
                        }}
                    </p>
                    <!--
                        An emptied lane keeps its header rather than collapsing: three columns shrinking to one
                        mid-keystroke would jump the whole board under the cursor.
                    -->
                    <p
                        v-else-if="
                            cardsFor(lane.key).length === 0 && runsFor(lane.key).length === 0 && !(lane.key === 'attention' && heldWakes.length > 0)
                        "
                        class="px-1 pb-3 text-2xs text-subtle"
                    >
                        {{ filtering ? "No matches in this lane." : lane.empty }}
                    </p>
                    <div v-else class="relative flex flex-col gap-2.5 pb-2.5">
                        <!--
                            Skips a card whose inputs haven't changed: the roster ticks about once a second per running
                            turn, and without this every lane would redraw every card just to update one elapsed
                            readout.
                        -->
                        <Transition
                            v-for="agent in cardsFor(lane.key)"
                            :key="agent.id"
                            v-memo="[
                                agent,
                                narrow,
                                draggedId === agent.id && dragging,
                                pendingFor(agent),
                                agent.id === highlightId || inPane(agent.id),
                                snippetOf(agent),
                                needle,
                                matchCase,
                            ]"
                            name="lane"
                        >
                            <AgentCard
                                :ref="(el) => setCardEl(agent.id, el)"
                                :agent="agent"
                                :dense="narrow"
                                :dragging="draggedId === agent.id && dragging"
                                :pending="pendingFor(agent)"
                                :selected="agent.id === highlightId || inPane(agent.id)"
                                :peek="peeked(agent.id)"
                                :match="snippetOf(agent)"
                                :query="needle"
                                :match-case="matchCase"
                                @open="(event) => focusAgent(agent, event)"
                                @keep="keepAgent(agent)"
                                @review="reviewAgent(agent)"
                                @resolve="resolveNow(agent.id, agent.sandboxId)"
                                @land="landNow(agent.id, agent.sandboxId)"
                                @reland="relandNow(agent.id, agent.sandboxId)"
                                @unwatch="unwatchNow(agent.id, agent.sandboxId)"
                                @archive="archive([agent.id])"
                                @restore="restore([agent.id])"
                                @close="closeAgent(agent)"
                                @grab="(event, card) => grabCard(event, agent, card)"
                                @contextmenu.prevent.stop="openCardMenu(agent, $event)"
                            />
                        </Transition>
                    </div>
                    <!--
                        The lane's tail, not a pager: the count is the point, and the row keeps them one press away
                        instead of gone; hidden while filtering, since the window is already lifted.
                    -->
                    <button
                        v-if="lane.key === 'finished' && !archiveOpen && !filtering && hiddenFinished > 0"
                        type="button"
                        :class="ui.addTile(`mb-2.5 gap-1.5 rounded-lg py-2 text-2xs`)"
                        @click="showAllFinished = !showAllFinished"
                    >
                        <Icon :name="showAllFinished ? 'chevron-up' : 'chevron-down'" class="text-2xs" />
                        {{ showAllFinished ? "Show fewer" : `${hiddenFinished} earlier` }}
                    </button>
                    <!--
                        One-way, unlike the lane's toggle: this pile has no "fewer" worth offering, since collapsing it
                        back would lose the reader's place mid-search.
                    -->
                    <button
                        v-if="lane.key === 'finished' && archiveOpen && archiveHidden > 0"
                        type="button"
                        :class="ui.addTile(`mb-2.5 gap-1.5 rounded-lg py-2 text-2xs`)"
                        @click="archiveShown += ARCHIVE_PAGE"
                    >
                        <Icon name="chevron-down" class="text-2xs" />
                        {{ archiveHidden }} more
                    </button>
                </section>
            </div>
            <!--
                The filter's own empty state, not the board's: agents exist, just none matched; names the rule that
                produced the miss (case sensitivity) rather than leaving a silent blank.
                The way out (Ignore case) is offered here rather than left as a hunt back to the switch, since a mode
                is only fair if the screen it emptied can also undo it.
            -->
            <p v-if="noMatches" class="px-4 pb-6 text-center text-2xs text-subtle">
                <template v-if="matchCase">
                    No agent mentions "{{ query.trim() }}" with those exact capitals.
                    <button type="button" class="font-medium text-link underline-offset-2 hover:underline" @click="matchCase = false">
                        Ignore case
                    </button>
                </template>
                <template v-else
                    >No agent of yours mentions "{{ query.trim() }}". This searches the titles and what either side said in the chat.</template
                >
            </p>
        </div>
        <!--
            What the query found off the board: the Finished window and the archive both hide agents the filter would
            otherwise miss entirely, reading "no matches" for a hit one click away.
            Collapsed by default, re-collapsed on every new query, since the board is the answer and this is its
            footnote.
            Sits outside the board's own `h-full` scroller, or the row would be pushed past the fold and only reachable
            by hunting for it.
        -->
        <div v-if="beyondVisible" class="flex max-h-[50%] shrink-0 flex-col border-t border-line px-3 pb-3 pt-2" :class="narrow ? '' : 'lg:px-4'">
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
                <section v-if="archivedHits.length > 0" class="flex min-w-0 flex-col gap-2.5">
                    <div class="flex items-center gap-2 px-1">
                        <Icon name="box" class="shrink-0 text-2xs text-subtle" />
                        <span class="text-2xs font-semibold uppercase tracking-wide text-muted">In the archive</span>
                        <span class="rounded-full bg-overlay px-1.5 py-px text-2xs text-muted">{{ archivedHits.length }}</span>
                    </div>
                    <!--
                        Real cards, not a stripped list: an archived agent keeps its branch, diff and transcript, so
                        reading or restoring it is exactly what the card already offers.
                        `unwatch` is the one action wired here besides those two, and the only press this card keeps in
                        the archive, since a watch is what would wake it back into a lane.
                    -->
                    <div class="grid gap-2.5" :class="narrow ? '' : 'grid-cols-3 items-start lg:gap-4.5'">
                        <AgentCard
                            v-for="agent in archivedHits"
                            :key="agent.id"
                            :agent="agent"
                            :dense="narrow"
                            :pending="pendingFor(agent)"
                            :selected="agent.id === highlightId || inPane(agent.id)"
                            :match="snippetOf(agent)"
                            :query="needle"
                            :match-case="matchCase"
                            @open="(event) => focusAgent(agent, event)"
                            @review="reviewAgent(agent)"
                            @restore="restore([agent.id])"
                            @unwatch="unwatchNow(agent.id)"
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
                    <!--
                        Conversations no agent entry owns; with no card to draw, they read as history rows and open as
                        tabs, the same act the History menu performs.
                    -->
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
                            :match-case="matchCase"
                            class="line-clamp-2 text-2xs text-muted"
                        />
                        <span class="text-2xs text-subtle">{{ relativeTime(session.updatedAt) }}</span>
                    </button>
                </section>
            </div>
        </div>
        <!--
            Discard is destructive and has no lane of its own, so it only exists while a card is actually being
            dragged.
        -->
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
        <!--
            A drag is the easiest gesture here to trigger by accident, and dropping a conflicted card on Finished
            spends a turn, so unlike stop/land/discard it confirms first.
        -->
        <Modal :open="pendingResolve !== undefined" size="sm" header="Have the agent resolve the conflict?" @update:open="cancelResolve">
            <p class="text-xs text-content">
                {{ resolveTarget?.title ?? `This agent` }} will start a turn: it rebases its branch onto your current workspace, resolves the conflict
                in its own worktree, and lands the result when it's done.
            </p>
            <p class="mt-2 text-xs text-muted">Nothing is written to your workspace unless it succeeds. You can stop the turn at any point.</p>
            <template #footer>
                <Button size="small" severity="secondary" :text="true" label="Cancel" @click="cancelResolve" />
                <Button size="small" label="Ask the agent" @click="confirmResolve" />
            </template>
        </Modal>
        <!--
            The one dialog guarding something unrecoverable: says what goes in the terms the archive has promised all
            along ("nothing is lost"), and what stays (already-landed work).
        -->
        <Modal :open="pendingPurge" size="sm" header="Delete every archived agent?" @update:open="pendingPurge = false">
            <p class="text-xs text-content">
                {{ archived.length }} archived agent{{ archived.length === 1 ? "" : "s" }} will be deleted for good, each one's branch, its
                conversation and its history. This cannot be undone.
            </p>
            <p class="mt-2 text-xs text-muted">
                Work they already landed stays in your workspace. Only what never left their branches is lost. Agents still on the board are
                untouched.
            </p>
            <template #footer>
                <Button size="small" severity="secondary" :text="true" label="Cancel" @click="pendingPurge = false" />
                <Button size="small" severity="danger" @click="confirmPurge">
                    Delete {{ archived.length }} agent{{ archived.length === 1 ? "" : "s" }}
                </Button>
            </template>
        </Modal>
        <!--
            A real card, so the drag reads as the card itself; `pointer-events-none` keeps the hit test on what's
            underneath it.
        -->
        <div v-if="dragging && dragged !== undefined" class="pointer-events-none fixed left-0 top-0 z-50 rotate-2" :style="ghostStyle">
            <div class="opacity-90 shadow-lg">
                <AgentCard :agent="dragged" :dense="narrow" />
            </div>
            <p
                class="mt-1 inline-block rounded px-2 py-1 text-2xs font-medium"
                :class="action !== undefined ? 'bg-primary-fill/10 text-primary-fill border border-primary-fill/20' : 'bg-overlay text-subtle'"
            >
                {{ hint }}
            </p>
        </div>
        <!-- One menu for every card on the board; see cardMenuItems. -->
        <ContextMenu ref="cardMenu" :model="cardMenuItems" :min-width="12" />
    </div>
</template>
<style scoped>
/*
 * Scale-fade on lane entry/exit without a list-level FLIP probe; a leaving card is absolutely positioned so its lane
 * collapses immediately while it finishes fading.
 */
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
