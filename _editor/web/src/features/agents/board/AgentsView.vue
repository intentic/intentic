<script setup lang="ts">
import { composingKey } from "@intentic/ui/keys";
import {
    Button,
    ConfirmDialog,
    ContextMenu,
    FloatingAction,
    ProjectChip,
    SwipeRow,
    toneWash,
    ui,
    useDevice,
} from "@intentic/ui";
import { computed, inject, onMounted, provide, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { startAgent } from "../../../models/fleet/agentActions";
import { usePanels } from "../../../models/extensions/usePanels";
import { useChanges } from "../../../models/changes/useChanges";
import { synthesizing } from "../fleet/synthesizeSessions";
import { dropHint, pendingOf } from "./laneDrop";
import { useAgentDrag } from "./useAgentDrag";
import { useAgentFilter } from "./useAgentFilter";
import { projectScope, setProjectScope } from "../../../app/projectScope";
import { useRoles } from "../../../models/sandbox/roles/useRoles";
import { useAuth } from "../../../client/auth/useAuth";
import { foreignShare } from "../../../models/fleet/presses/foreignPress";
import { presenceOthers } from "../../../workbench/presence/usePresence";
import { useSandboxSharedAccess } from "../../../models/sandbox/useSandboxSharedAccess";
import { useAgents } from "../../../models/fleet/useAgents";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { agentDisplayTitle } from "../../../models/agent-status/agentStatus-meta";
import { useVocabulary } from "../../../workbench/views/vocabulary";
import { listedViewMissing, WORKFLOWS } from "../../../workbench/views/listedViews";
import type { FleetAgent } from "../../../models/fleet/useAgents-fleet";
import { pendingOn } from "../../../models/fleet/useAgents-provisional";
import { useWorkflowRuns } from "../../../models/fleet/useWorkflowRuns";
import { useSubagentRoster } from "../../../models/fleet/subagentRoster";
import { chatOnScreen, chatWide, showChat } from "../../../models/conversations/panel/chatPanelLayout";
import { subagentOnScreen } from "../../../models/conversations/panel/subagentView";
import { openRunInChat, pointAtChat } from "../../../models/fleet/openRun";
import { summonChat } from "../../../models/conversations/run/summon";
import { chatStrip } from "../../../models/conversations/panel/useChat-strip";
import LaneHeader from "../../../components/LaneHeader.vue";
import AgentCard from "./cards/AgentCard.vue";
import BeyondResults from "./BeyondResults.vue";
import { cardSwipeAction, cardSwipeOf } from "./cards/cardSwipe";
import FirstAgentSlot from "./cards/FirstAgentSlot.vue";
import LaneSkeleton from "./cards/LaneSkeleton.vue";
import { markHinted } from "../../tour/tourMarks";
import ChildRows from "../../../parts/fleet/ChildRows.vue";
import { CHILD_ROWS } from "../../../models/fleet/board/childRows";
import { cardKey } from "../../../models/fleet/board/childFold";
import HeldWakeCard from "./cards/HeldWakeCard.vue";
import LaunchCards from "./cards/LaunchCards.vue";
import AttentionElsewhere from "./cards/AttentionElsewhere.vue";
import WorkflowRunCard from "./cards/WorkflowRunCard.vue";
import ActiveGroupHead from "./ActiveGroupHead.vue";
import FinishedLaneActions from "./FinishedLaneActions.vue";
import BoardSearch from "./BoardSearch.vue";
import BoardOwnerScope from "./BoardOwnerScope.vue";
import { useArchiveDoor } from "./view/archiveDoor";
import { useBoardCommands } from "./view/boardCommands";
import { laneHeads, useBoardLanes } from "./view/boardLanes";
import NoMatchesNote from "./NoMatchesNote.vue";
import BoardMetrics from "../metrics/BoardMetrics.vue";
import BoardNight from "../night/BoardNight.vue";
import { LIVE_METRICS_KEY } from "../../../models/sandbox/liveMetrics";
import { usePhoneLanes } from "./view/phoneLanes";
import { useBoardLaunches } from "./view/boardLaunches";
import { useAttentionAsk } from "./view/attentionAsk";
import { useBoardPresses } from "./view/boardPresses";
import { useBoardScope } from "../../../models/fleet/board/boardScope";
import { useBoardView } from "./view/boardView";
import { GRID_PAD, LANE_GLYPH, useBoardGrid } from "./view/boardGrid";
import { useCornerFit } from "./view/cornerFit";
import { useCardMenu } from "./view/cardMenu";
import { useFamilyArchive } from "./view/familyArchive";
import { useCardFocus, useCardRing } from "./view/cardSelection";
import { useFoundCard } from "./view/foundCard";
import { boardStarters } from "./view/firstScreen";
import { useRowReveal } from "@intentic/ui/motion";
import { laneOrder, useLaneMotion } from "./view/laneMotion";
import { useT } from "@intentic/ui/i18n";
import { useWallpaper } from "../../../skins/useWallpaper";
import { useNoticeToasts } from "./view/boardNotices";
// Kanban across Attention/Active/Finished, pure projections of laneOf; a drop runs the action that causes a lane change
// (laneDrop), never assigns status directly. Template and wiring: what the lanes draw and cover, how the board is being
// read, the selection, the menu, the motion and the commands are the headless modules in `view/`.
const t = useT();
const { withCorner = false } = defineProps<{ withCorner?: boolean }>(); // a `corner` slot to stand at Finished's foot (cornerFit.ts)
const router = useRouter();
const { mobile, coarse } = useDevice();
// The geek metrics are the desktop's: its shell reads them once (ShellDesktop.vue) for this board's header and its cards
// (liveMetrics.ts), undefined while they are off. A phone reads none, whatever Settings says: its board has no foot to
// spare from the floating New agent.
const liveMetrics = inject(LIVE_METRICS_KEY, undefined);
const agents = useAgents();
const { archived, archiveLoading, archiveFailure, archive, restore, notice, dismissNotice } = agents;
// A refused press is said as a toast in the app's notification lane (boardNotices.ts).
useNoticeToasts(notice, dismissNotice);
const drag = useAgentDrag();
const { dragged, dragging, draggedId, over, action, accepts, ghostStyle, pendingResolve, confirmResolve, cancelResolve } = drag;
const { resolveNow, keepDeletedNow, restoreDeletedNow, pressLand, pendingLand, confirmLand, cancelLand, unwatchNow } = drag;
// The press a phone's land confirm ends in, in the reader's words for it, and the card it names.
const words = useVocabulary();
const landingName = computed(() => pendingLand.value?.title ?? t(`agents.agentsView.thisAgent`));
// Resolved live, so a rename or a status change stays visible while the dialog asks.
const resolveTarget = computed(() => (pendingResolve.value === undefined ? undefined : agents.agentById(pendingResolve.value)));
const hint = computed(() => dropHint(action.value, dragged.value, over.value));
const pendingFor = (agent: FleetAgent) => pendingOf(agent, pendingOn(agent.id, agent.sandboxId), agents.busyIds.value);
// Its field is always on the header, not behind a glyph, so nobody has to learn the board is searchable.
const filter = useAgentFilter();
const { query, needle, matchCase, active: filtering, snippetOf, idMatchOf, sessionMatches, searching, partial: searchPartial } = filter;
const filterField = ref<InstanceType<typeof BoardSearch> | undefined>(undefined);
const { view, move } = useBoardView(needle);
const workflows = useWorkflowRuns();
const { roles } = useRoles();
const { user } = useAuth();
// How much of the archive is other people's, for the one press that deletes all of it (the purge confirm below).
const othersArchived = computed(() => foreignShare(archived.value, user.value?.email, presenceOthers.value));
const { sharedAccess } = useSandboxSharedAccess();
const scope = useBoardScope({ agents, runs: workflows.runs, roles, me: computed(() => user.value?.email), sharedAccess });
const { ownerOptions, ownerScope, projectHidden, attentionElsewhere, scopedHeld } = scope;
const ring = useCardRing({ mobile, strip: chatStrip, wide: chatWide, runs: workflows.runs });
const { highlightId, inPane } = ring;
// The subagent this window's chat is stepped into, while its parent's column is still what the chat shows. The view is
// held per window and only the panel prunes it (keepSubagentWhileShown), so with the chat popped out this window's copy
// outlives the column: read on its own it rings a row the reader has since moved away from.
const subagentShown = computed(() => {
    const shown = subagentOnScreen.value;
    return shown !== undefined && (shown.parentId === highlightId.value || inPane(shown.parentId)) ? shown : undefined;
});
// A card or spawned child wears the ring while the chat shows it, unless it is only the column a subagent is shown in:
// the row pressed is what is selected, not its parent (ChatRowList's rule).
const ringed = (id: string): boolean => (id === highlightId.value || inPane(id)) && subagentShown.value?.parentId !== id;
// The subagents each card's runtime ran in-process, which ride in its tray beside the conversations it spawned.
const roster = useSubagentRoster();
// Switched to a sandbox whose roster this browser neither heard nor remembers: the lanes would hold its drafts alone
// until the stream answers, so they hold placeholders instead. Not while it refuses outright, which no wait answers,
// nor in the archive, which is its own read.
const { connection } = useSandbox();
const waiting = computed(() => !agents.rosterKnown.value && connection.value.phase !== `blocked` && !view.value.archive);
const lanes = useBoardLanes({ view, scope, filter, drag, agents, roster, selected: highlightId, waiting });
const { cardsFor, runsFor, needingYou, archivedCards, archiveSize, archiveHidden, hiddenFinished, archivedHits, laneDropClass } = lanes;
const { childrenOf, subagentsOf, callOf, familyOf, familyIds } = lanes;
const { beyondVisible, beyondLabel, beyondOnly, matchTally, noMatches, clearable, first } = lanes;
// A restored hit lands on the board and so ends `beyondOnly`; the list the reader is going through stays open rather than folding under them.
const restoreFound = (agent: FleetAgent): void => {
    if (beyondOnly.value) {
        move({ kind: `unfold` });
    }
    void restore([agent.id]);
};
// What opens and shuts the trays under the cards (ChildRows' `shown`): the ring, the panes beside it, a subagent's
// transcript on screen, one of Active's groups folded. A render that moves any of it is one the lanes' motion measures across.
const folds = (): string => `${highlightId.value}|${chatStrip.value.panes.join(`,`)}|${subagentShown.value?.id}|${lanes.activeFolded.value}`;
const { setCardEl, isMovingLane, revealCard } = useLaneMotion({ lanes: scope.boardLanes, filtering, drag, folds });
const focus = useCardFocus({
    ring,
    lanes,
    filter,
    agents,
    drag,
    move,
    reveal: revealCard,
    router,
    route: useRoute(),
    mobile,
    strip: chatStrip,
    summon: summonChat,
});
const { focusAgent, focusSubagent, drillIn, reviewAgent, enterAgent, closeAgent, openSession } = focus;
// The card the filter names by its id: the lanes lead with it, it is scrolled to, and Enter in the field opens it as a
// click would; with nothing named, Enter does what it always did, which is nothing.
const { found, openFound } = useFoundCard({ filter, lanes, move, reveal: revealCard, open: (agent) => focusAgent(agent) });
const onFieldEnter = (event: KeyboardEvent): void => {
    // Enter that confirms an IME composition is the composition's, not a request to open anything.
    if (composingKey(event)) {
        return;
    }
    if (openFound()) {
        event.preventDefault();
    }
};
// What the halo says to a reader who cannot see it.
const foundAnnouncement = computed(() =>
    found.value === undefined ? `` : t(`agents.agentsView.foundById`, { title: agentDisplayTitle(found.value) }),
);
// A card's archive and restore take the children riding under it (boardTrays.familyOf), from the card and its menu alike;
// an archive that takes any asks first, with the count (familyArchive.ts).
const withFamilies = (ids: readonly string[]): string[] => lanes.withFamilies(ids, agents.agentById);
const familyArchive = useFamilyArchive({ archive, familyIds, agentById: agents.agentById, coarse });
const { pending: pendingFamilyArchive, heading: familyArchiveHeading } = familyArchive;
// A card a thumb swipes aside on a touch screen runs its own filing press (cardSwipe.ts): an archive asks first when it
// takes children along, and leaves the same receipt with Undo a touch screen gets for one card.
const swipeOf = (agent: FleetAgent) => {
    const swipe = coarse.value ? cardSwipeOf(agent) : undefined;
    return swipe === undefined ? undefined : cardSwipeAction(swipe);
};
const swipeCard = (agent: FleetAgent): void => {
    switch (cardSwipeOf(agent)) {
        case `archive`:
            void familyArchive.request(agent);
            return;
        case `restore`:
            void restore(familyIds(agent));
            return;
        case `close`:
            closeAgent(agent);
            return;
    }
};
const { cardMenu, cardMenuItems, openCardMenu } = useCardMenu({
    mobile,
    focus,
    agents: {
        // The menu does not read what a stop answered (StopOutcome): the card it moves is the answer there.
        stopWatching: async (id) => void (await agents.stopWatching(id)),
        // No ids is the lane's Clear, which already names every finished card there is.
        archive: familyArchive.requestIds,
        restore: (ids) => restore(withFamilies(ids)),
    },
    // What's selected IS what's on screen: a card in a split is marked with every card beside it (inPane).
    selected: (agent) => (inPane(agent.id) ? chatStrip.value.panes.flatMap((id) => agents.agentById(id) ?? []) : [agent]),
});
// The trays under the cards (ChildRows), which follow their children, fold and ring on their own clock (childRows.ts).
provide(CHILD_ROWS, {
    childrenOf,
    subagentsOf,
    stateOf: lanes.trayState,
    toggle: lanes.toggleTray,
    // An in-process row is on screen while this window's chat shows its transcript (subagentView.ts).
    selected: (id) => ringed(id) || subagentShown.value?.id === id,
    needle,
    matchCase,
    idMatchOf,
    open: (child, event) => focusAgent(child, event),
    openSubagent: focusSubagent,
    review: drillIn,
    menu: openCardMenu,
    setRowEl: setCardEl,
});
const { announcement, pendingPurge, purging, pulsing, toggleArchive, confirmPurge } = useArchiveDoor({ view, move, agents });
const { stoppingRuns, stopRun, archiveRun, restoreRun, openRun, openRunGraph, releaseWake, synthesize, starts, clears } = useBoardPresses({
    workflows,
    agents,
    router,
    workflowsPage: computed(() => !listedViewMissing(WORKFLOWS.view)),
    chat: {
        strip: chatStrip,
        // Where ChatPanel draws a run's diagram: a wide panel, on a desktop.
        diagram: computed(() => chatWide.value && !mobile.value),
        mobile,
        // As an agent card's press does (cardSelection.focusAgent): a chat folded into its strip comes back to show what moved.
        follow: (run) => {
            void openRunInChat(run);
            showChat();
        },
        point: pointAtChat,
    },
});
useBoardCommands({ agents, filterField });
// A filtered board is a result set wearing the lanes' shape, so it doesn't drag: half the lanes may read "no matches"
// and a drop would act on a lane the user isn't really seeing.
const grabCard = (event: PointerEvent, agent: FleetAgent, card: HTMLElement): void => {
    if (filtering.value) {
        return;
    }
    drag.begin(event, agent, card);
};
const boardEl = ref<HTMLElement | undefined>(undefined);
const LANES = computed(laneHeads);
// A wallpaper shows through the lanes (wallpapers.css), so their headers drop the band of the board's ground they pin on
// (the chat's own surface without one, Agents.vue); a pinned header with nothing behind it would slide over the cards
// scrolling under it, so they scroll away with the lane.
const { wallpaper } = useWallpaper();
const papered = computed(() => wallpaper.value !== `none`);
useAttentionAsk({
    board: boardEl,
    filtering,
    clearFilter: () => {
        query.value = ``;
    },
    inArchive: computed(() => view.value.archive),
    leaveArchive: toggleArchive,
    rows: () => ({ cards: cardsFor(`attention`), runs: runsFor(`attention`), wakes: scopedHeld.value.length }),
    openCard: (agent) => focusAgent(agent),
    openRun,
});
// Workspace facts the starters turn on, already fetched for the rail elsewhere: the board adds no fetch of its own.
const { panels: workspaceRepos } = usePanels();
const workspaceChanges = useChanges();
const starters = computed(() => boardStarters(workspaceRepos.value.length, workspaceChanges.count.value));
const launching = useBoardLaunches(computed(() => view.value.archive));
// A phone draws only the lanes with something in them (phoneLanes.ts).
const { drawnLanes, bareLane, saysEmpty, content } = usePhoneLanes({ mobile, heads: LANES, view, lanes, scope, dragging, filtering, launching, waiting });
// The lanes' grid at the board's width and by which in-flight lanes are empty, and Finished's fold (boardGrid.ts).
const { narrow, fit, placed, laneGrid, placeOf, spans, sayInHeader, toggleFinished } = useBoardGrid({ board: boardEl, view, move, content, saysEmpty, filtering, first, waiting, dragging, anchored: computed(() => withCorner) });
// A slim board's header (boardGrid.ts `CardFit`): the owner filter a picker, the field a glyph that takes the row once open,
// and only what still fits beside them; a sliver of a board keeps the field alone.
const slim = computed(() => fit.value !== `full` && !mobile.value);
const sliver = computed(() => fit.value === `mini` || fit.value === `tile`);
const searchOpen = ref(false);
const searchRow = computed(() => slim.value && (searchOpen.value || query.value !== ``));
const { scroller: scrollerEl, grid: gridEl, active: cornered, attach: attachCorner, lane: cornerLane, cards: cornerCards, earlier, tailed } = useCornerFit({ drawn: () => withCorner, narrow, view, filtering, hiddenFinished, tailRow: () => fit.value === `tile` });

// Being here is what the getting-started board moment asks for: once the reader has seen the board, it stops pointing.
onMounted(() => markHinted(`board`, `visited`));

// THE BOARD OPENS ROW BY ROW (@intentic/ui/motion, reveal.ts): the lanes and their headings are there at once, and the
// cards in them arrive in reading order, row one of every lane together, then row two, so the board is seen filling
// the way it is read and the opening lasts as long as the longest lane, capped, never as long as every card. Stacked
// on a narrow screen, the lanes are one column read top to bottom, so the whole board is one column here too. Rows are
// what a lane holds (`data-reveal`): held wakes, runs and agent cards with their trays.
//
// A CARD ARRIVING after that scale-fades into its lane (`lane` below): a new agent, or a filter's matches coming back.
// Each card sits in its own <Transition>, which only plays an entrance with `appear`, so `appear` turns on once the
// opening has played (`boardDrawn`); before then a card is part of the opening, not news.
const boardRows = (): string =>
    [laneOrder(scope.boardLanes.value), LANES.value.map((lane) => runsFor(lane.key).map((run) => run.runId)), scopedHeld.value.map((entry) => entry.id)].join(`#`);
const { settled: boardDrawn } = useRowReveal(boardEl, { key: boardRows });
</script>
<!-- `relative` positions the lane-drop affordances only; the fixed drag ghost and the app's notification lane need no containing block here. -->
<!-- `overflow-x-clip`: nothing the board holds outside its scroller (the header row, what is positioned against this box)
     may scroll the section around it sideways either. A clip, not a scroller, so it costs the sticky headers nothing, and
     the fixed ghost and drop target, placed against the window, are not cut by it. -->
<!-- Kept outside the template: a comment inside it makes this multi-root, and dev patches a multi-root subtree
     unoptimized — every slotted child, closed dialogs included, redraws on every board render. -->
<template>
    <div ref="boardEl" class="agents-board relative flex h-full min-h-0 flex-col overflow-x-clip">
        <!-- The board's segment of the window's top bar (`.view-header`), blended: the wallpaper runs up under it (wallpapers.css
             paints `.agents-board`) with no line, and it is one row, never two, so its height meets the chat's.
             Wide, three columns, the outer two of equal share, so the search sits in the middle of the board whatever stands
             either side of it (the owner filters on the left, the geek metrics and New agent on the right). Narrow, the
             groups keep their controls' width and the search takes what is left. A phone has no such bar: there the search
             takes a row of its own, at a finger's height. -->
        <div
            class="view-header view-header-blend items-center gap-2 px-3"
            :class="mobile ? 'view-header-wrap flex flex-wrap gap-y-1 py-1' : narrow ? 'flex' : 'grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]'"
        >
            <div v-show="!searchRow" class="col-start-1 flex min-w-0 items-center gap-2" :class="mobile ? `flex-auto flex-wrap` : slim ? `min-w-0 flex-1` : narrow ? `shrink-0` : ``">
                <!-- Whose sessions the board shows; hidden when access names only one person, since Everyone and Mine say the same thing, on a first run, with no sessions to split, and on a tile board, whose header holds the filter alone. -->
                <BoardOwnerScope v-if="user !== null && sharedAccess && !first && fit !== `tile`" v-model="ownerScope" :options="ownerOptions" :folded="slim" :mobile="mobile" />
                <!-- The open project, and the way out of it: the same scope the workspace chip clears, so both say the same thing. -->
                <ProjectChip :project="projectScope" :hidden="projectHidden" noun="agents" @clear="setProjectScope(undefined)" />
            </div>
            <!-- Not on a first run: there is nothing yet to filter, and a field over an empty board reads as the board's
                 point. It arrives with the first card, in the place it keeps. -->
            <BoardSearch
                v-if="!first || filtering"
                ref="filterField"
                v-model="query"
                v-model:match-case="matchCase"
                v-model:open="searchOpen"
                :folds="slim"
                :dense="!mobile"
                :busy="searching"
                :field-class="mobile ? 'order-last basis-full' : narrow ? 'min-w-24 flex-1' : 'col-start-2 mx-auto w-72 max-w-full shrink-0'"
                @enter="onFieldEnter"
            />
            <!-- One row, never two: what is here gives way inside it (the metrics step down with this container's width,
                 SandboxMetricsSummary.vue) rather than pushing New agent under the rest. -->
            <div v-show="!searchRow" class="col-start-3 flex min-w-0 items-center justify-end gap-2" :class="mobile ? 'flex-auto' : narrow ? 'shrink-0' : '@container/tools'">
                <!-- Filtering shows a searching state while lane counts are partial. -->
                <span v-if="filtering && !sliver" class="shrink-0 text-2xs text-muted" :aria-busy="searchPartial">{{ matchTally }}</span>
                <!-- The geek metrics, while the reader opted in: three small meters beside New agent, the full readout a
                     popover off them (BoardMetrics.vue). In the header, so they take none of the board's height. -->
                <BoardMetrics v-if="!mobile && !sliver && liveMetrics !== undefined" :metrics="liveMetrics" :compact="narrow" />
                <!-- Appears exactly when two or more chats sit side by side (the panes are the selection); opens a draft composed from their transcripts but not sent. -->
                <Button
                    v-if="chatStrip.panes.length >= 2"
                    size="small"
                    tier="boring"
                    :disabled="synthesizing"
                    class="shrink-0"
                    v-tooltip.bottom="slim ? t(`agents.agentsView.synthesize`) : undefined"
                    @click="synthesize"
                >
                    <Icon :name="synthesizing ? `spinner` : `sparkles`" :spin="synthesizing" /><template v-if="!slim">{{ t(`agents.agentsView.synthesize`) }}</template>
                    {{ chatStrip.panes.length }}
                </Button>
                <!-- The night begun by hand, for an evening someone goes to bed before their night hours: a bare moon at rest,
                     lit with the morning while it is night (BoardNight.vue). On a phone it holds this corner alone. -->
                <BoardNight v-if="!sliver" />
                <!-- A phone floats it over the board instead (below), where the thumb is and the filters get the row. Beside an
                     open chat it is the chat header's + instead, the same press a column away; folded into its strip or
                     in a window of its own, the chat has no + on this page, and this one comes back. -->
                <Button tier="boring" v-if="!mobile && starts && !chatOnScreen" size="small" thumb class="shrink-0" @click="startAgent()">
                    <Icon name="plus" />{{ words.newAgent }}
                </Button>
            </div>
        </div>
        <!-- What the counter's pulse can't tell a screen reader; covers every archive so the visual pill stays purely visual. -->
        <span class="sr-only" aria-live="polite">{{ announcement }}</span>
        <span class="sr-only" aria-live="polite">{{ foundAnnouncement }}</span>
        <!-- ALWAYS THE LANES, a first run and a cleared board included (firstScreen.ts): the board a reader meets first is the
             one they keep, and the first agent's card arrives in the slot drawn where it will sit. -->
        <!-- No padding of its own: the stacked board's sticky lane headers pin to top-0, and padding would leave a gap above them. -->
        <div ref="scrollerEl" class="scrollbar-stable min-h-0 flex-1 overflow-auto">
            <!-- `content-start` keeps stacked rows from stretching to `h-full`; a phone's board ends with room for the floating New agent. -->
            <!-- NEVER SIDEWAYS (`overflow-x-clip`): wider than its fraction is a card spilling, which handed the board a horizontal scrollbar; a clip, so sticky headers still pin. -->
            <div ref="gridEl" class="grid overflow-x-clip" :class="[GRID_PAD[fit], laneGrid, noMatches ? '' : placed || cornered ? 'min-h-full' : 'h-full', mobile ? 'pb-24' : '']">
                <section
                    v-for="lane in drawnLanes"
                    :key="lane.key"
                    :data-lane="lane.key"
                    :data-reveal-column="narrow ? undefined : ``"
                    :data-drop="lane.key === 'finished' && view.archive ? undefined : lane.key"
                    class="flex min-w-0 flex-col rounded-xl transition-colors"
                    :class="[!dragging && !narrow && !placed ? 'min-h-0' : '', placeOf(lane.key), laneDropClass(lane.key), cornered && lane.key === 'finished' ? 'sticky self-start' : '']"
                    :style="lane.key === 'finished' ? cornerLane : undefined"
                >
                    <!-- Finished's header doubles as the archive's window, swapping its label and growing a way back; pinned while scrolling, unless a wallpaper shows through. -->
                    <LaneHeader :label="lane.label" class="rounded-t-xl px-1" :class="papered ? '' : 'sticky top-0 z-10 bg-card'">
                        <template v-if="lane.key === 'finished' && view.archive" #mark>
                            <button
                                type="button"
                                :aria-label="t(`agents.agentsView.backToFinishedAgents`)"
                                v-tooltip.bottom="t(`agents.agentsView.leaveArchive`)"
                                :class="ui.iconButton({ size: `xs` })"
                                @click="toggleArchive"
                            >
                                <Icon name="arrow-left" class="text-2xs" />
                            </button>
                        </template>
                        <!-- A tile board's lane is its glyph, the name in its hover: a name cut to "ATTE…" said nothing. -->
                        <template v-else-if="fit === `tile`" #mark>
                            <Icon :name="LANE_GLYPH[lane.key]" v-tooltip.right="lane.label" :aria-label="lane.label" role="img" class="mx-auto text-xs text-subtle" />
                        </template>
                        <template v-if="lane.key === 'finished' && view.archive" #label>{{ t(`shared.archived`) }}</template>
                        <template v-else-if="fit === `tile`" #label><span class="sr-only">{{ lane.label }}</span></template>
                        <template v-if="lane.key === 'finished' && view.archive && archiveLoading" #info>
                            <Icon name="spinner" spin class="text-2xs text-muted" />
                        </template>
                        <template v-else-if="sayInHeader(lane.key)" #info>
                            <span class="ml-2 min-w-0 truncate text-2xs text-subtle">{{ filtering ? t(`agents.agentsView.noMatchesInLane`) : lane.empty }}</span>
                        </template>
                        <template v-if="lane.key === 'finished'" #actions>
                            <FinishedLaneActions
                                :view="view"
                                :filtering="filtering"
                                :tailed="!waiting && tailed"
                                :earlier="earlier"
                                :archive-size="archiveSize"
                                :pulsing="pulsing"
                                :clearable="clears ? clearable : 0"
                                :archived="archived.length"
                                :purging="purging"
                                :fit="fit"
                                @fewer="toggleFinished"
                                @door="toggleArchive"
                                @clear="archive()"
                                @purge="pendingPurge = true"
                            />
                        </template>
                    </LaneHeader>
                    <div :ref="lane.key === 'finished' ? attachCorner : undefined" :class="lane.key === 'finished' ? cornerCards : 'contents'">
                    <AttentionElsewhere v-if="lane.key === 'attention' && !view.archive && attentionElsewhere > 0" />
                    <!-- Held wakes lead the lane, since a hold is wholly waiting on the user, more than anything running below it; Attention lane only. -->
                    <div v-if="lane.key === 'attention' && !view.archive && scopedHeld.length > 0" class="flex flex-col gap-3.5 pb-2.5">
                        <HeldWakeCard
                            v-for="entry in scopedHeld"
                            :key="entry.id"
                            data-reveal
                            :entry="entry"
                            :dense="narrow"
                            :fit="fit"
                            @approve="releaseWake(entry.id, `approve`)"
                            @reject="releaseWake(entry.id, `reject`)"
                        />
                    </div>
                    <LaunchCards v-if="lane.key === 'active'" :launching="launching" :dense="narrow" :fit="fit" />
                    <!-- Runs sit above their lane's agent cards, since a run is a container of several of them and a container belongs above its contents, not among them. -->
                    <div v-if="runsFor(lane.key).length > 0" class="flex flex-col gap-3.5 pb-2.5">
                        <WorkflowRunCard
                            v-for="run in runsFor(lane.key)"
                            :key="run.runId"
                            data-reveal data-fit-unit
                            :run="run"
                            :dense="narrow"
                            :fit="fit"
                            :selected="chatStrip.run?.runId === run.runId"
                            :needs-you="needingYou.has(run.runId)"
                            :stopping="stoppingRuns.has(run.runId)"
                            @open="openRun(run)"
                            @graph="openRunGraph(run)"
                            @stop="stopRun(run)"
                            @archive="archiveRun(run)"
                            @restore="restoreRun(run)"
                        />
                    </div>
                    <!-- The roster not heard yet: the lane's cards are on their way, which its drafts alone would not say. -->
                    <LaneSkeleton v-if="waiting" :lane="lane.key" :dense="narrow" />
                    <!-- A failed read is said in place of "nothing archived", which would claim the archive is empty. -->
                    <p
                        v-else-if="lane.key === 'finished' && view.archive && archivedCards.length === 0 && runsFor('finished').length === 0"
                        class="px-1 pb-3 text-2xs"
                        :class="archiveFailure === undefined ? 'text-subtle' : 'text-danger'"
                        :role="archiveFailure === undefined ? undefined : 'alert'"
                    >
                        {{
                            archiveFailure ??
                            (view.purged ? words.archiveEmptied : words.archiveNothingYet)
                        }}
                    </p>
                    <!-- A first run's Active lane holds the first agent's slot, where its card will arrive. -->
                    <div
                        v-else-if="first && lane.key === 'active' && cardsFor('active').length === 0 && runsFor('active').length === 0 && launching.length === 0"
                        class="flex flex-col pb-2.5"
                    >
                        <FirstAgentSlot :starters="starters" />
                    </div>
                    <!-- An emptied lane keeps its header; where its column went to the others, its sentence rides that header (boardGrid.ts). -->
                    <template v-else-if="saysEmpty(lane.key)">
                        <p v-if="!sayInHeader(lane.key) && fit !== `tile`" class="px-1 pb-3 text-2xs text-subtle">
                            {{ filtering ? t(`agents.agentsView.noMatchesInLane`) : first ? lane.first : lane.empty }}
                        </p>
                    </template>
                    <!-- A lane spanning the board (boardGrid's ledger) takes two columns of cards rather than one line each. -->
                    <div
                        v-else-if="!bareLane(lane.key)"
                        class="relative gap-4.5 pb-2.5"
                        :class="spans(lane.key) ? 'grid grid-cols-2 items-start' : 'flex flex-col'"
                    >
                        <template v-for="(group, at) in lanes.groupsFor(lane.key)" :key="group.key">
                            <ActiveGroupHead v-if="group.headed" :group="group" :first="at === 0" class="col-span-full" />
                            <!-- Skips a card whose inputs haven't changed (the roster ticks about once a second per running turn); keyed by box and id, since across sandboxes an id is not a card (a person's home conversation is named alike in every one). -->
                            <Transition
                                v-for="agent in group.shown"
                                :key="cardKey(agent)"
                                v-memo="[
                                    agent,
                                    narrow,
                                    fit,
                                    draggedId === agent.id && dragging,
                                    familyOf(agent).length,
                                    callOf(agent),
                                    lane.key,
                                    pendingFor(agent),
                                    ringed(agent.id),
                                    snippetOf(agent),
                                    idMatchOf(agent),
                                    needle,
                                    matchCase,
                                    isMovingLane(agent.id),
                                    coarse,
                                ]"
                                :name="isMovingLane(agent.id) ? undefined : 'lane'"
                                :css="!isMovingLane(agent.id)"
                                :appear="boardDrawn"
                            >
                                <!-- A card and the children riding under it (ChildRows), one unit to the lane: they arrive, leave, space and slide as one (laneMotion). -->
                                <div class="flex flex-col" data-fold-unit data-reveal>
                                    <!-- Swiped aside on a touch screen, the card files itself (cardSwipe.ts); its ⋯ keeps the same press. -->
                                    <SwipeRow
                                        :action="swipeOf(agent)"
                                        :disabled="pendingFor(agent) !== undefined"
                                        class="rounded-2xl"
                                        @commit="swipeCard(agent)"
                                    >
                                        <AgentCard
                                            :ref="(el) => setCardEl(agent.id, el)"
                                            :agent="agent"
                                            :dense="narrow || group.rows"
                                            :fit="fit"
                                            :dragging="draggedId === agent.id && dragging"
                                            :pending="pendingFor(agent)"
                                            :selected="ringed(agent.id)"
                                            :still="agent.id !== highlightId"
                                            :match="snippetOf(agent)"
                                            :id-match="idMatchOf(agent)"
                                            :query="needle"
                                            :match-case="matchCase"
                                            :family="familyOf(agent).length"
                                            :placed="lane.key"
                                            :call="callOf(agent)"
                                            @open="(event) => focusAgent(agent, event)"
                                            @review="drillIn(agent)"
                                            @changes="reviewAgent(agent)"
                                            @enter="enterAgent(agent)"
                                            @resolve="resolveNow(agent.id, agent.sandboxId)"
                                            @keep-deleted="(owner, main) => keepDeletedNow(agent.id, owner, main)"
                                            @restore-deleted="(owner) => restoreDeletedNow(agent.id, owner, agent.sandboxId)"
                                            @land="pressLand(agent, `land`, mobile)"
                                            @reland="pressLand(agent, `reland`, mobile)"
                                            @unwatch="unwatchNow(agent.id, agent.sandboxId)"
                                            @stop-job="(jobId) => agents.stopJob(agent.id, jobId)"
                                            @archive="familyArchive.request(agent)"
                                            @restore="restore(familyIds(agent))"
                                            @close="closeAgent(agent)"
                                            @grab="(event, card) => grabCard(event, agent, card)"
                                            menus
                                            @menu="(event, presses) => openCardMenu(agent, event, presses)"
                                        />
                                    </SwipeRow>
                                    <!-- A mini or tile card has no width for its rows: its corner names a child's ask (`call`), its chat the rest. -->
                                    <ChildRows
                                        v-if="fit === `full` || fit === `compact`"
                                        :agent="agent"
                                        :focused="ringed(agent.id)"
                                        :live="!narrow && lane.key !== `finished`"
                                        :compact="fit === `compact`"
                                        :class="draggedId === agent.id && dragging ? `opacity-40` : ``"
                                    />
                                </div>
                            </Transition>
                        </template>
                    </div>
                    <!-- The lane's fold lives in its header (FinishedLaneActions); a tile board's header has no room for it, so
                         there alone it stays a row under the cards: the count, one press away. Hidden while filtering. -->
                    <button
                        v-if="lane.key === 'finished' && fit === `tile` && !view.archive && !filtering && !waiting && tailed"
                        type="button"
                        :class="ui.addTile(`mb-2.5 gap-1.5 rounded-lg py-2 text-2xs`)"
                        :aria-label="view.all ? t(`ui.action.showFewer`) : t(`ui.action.showEarlier`, { count: earlier })"
                        data-fit-tail
                        @click="toggleFinished"
                    >
                        <Icon :name="view.all ? 'chevron-up' : 'chevron-down'" class="text-2xs" />
                        {{ view.all ? `` : earlier }}
                    </button>
                    <!-- One-way, unlike the lane's toggle: this pile has no "fewer" worth offering, since collapsing it back would lose the reader's place mid-search. -->
                    <button
                        v-if="lane.key === 'finished' && view.archive && archiveHidden > 0"
                        type="button"
                        :class="ui.addTile(`mb-2.5 gap-1.5 rounded-lg py-2 text-2xs`)"
                        @click="move({ kind: 'more' })"
                    >
                        <Icon name="chevron-down" class="text-2xs" />
                        {{ archiveHidden }} {{ t(`agents.agentsView.more`) }}
                    </button>
                    </div>
                    <div v-if="withCorner && lane.key === 'finished'" class="mt-auto flex min-h-0 flex-col pt-2.5"><slot name="corner" /></div>
                </section>
            </div>
            <NoMatchesNote v-if="noMatches" v-model:query="query" v-model:match-case="matchCase" />
        </div>
        <!-- What the query found off the board: the Finished window and the archive both hide agents the filter would otherwise miss entirely. -->
        <BeyondResults
            v-if="beyondVisible"
            :agents="archivedHits"
            :sessions="sessionMatches"
            :label="beyondLabel"
            :open="view.beyond || beyondOnly"
            :fill="beyondOnly"
            :narrow="narrow"
            :needle="needle"
            :match-case="matchCase"
            :snippet-of="snippetOf"
            :id-match-of="idMatchOf"
            :ringed="ringed"
            :busy="(agent) => pendingFor(agent) !== undefined"
            @toggle="move({ kind: 'beyond' })"
            @open="(agent, event) => focusAgent(agent, event)"
            @changes="reviewAgent"
            @restore="restoreFound"
            @menu="(agent, event) => openCardMenu(agent, event, {})"
            @open-session="openSession"
        />
        <!-- Discard is destructive and has no lane of its own, so it only exists while a card is actually being dragged. -->
        <div
            v-if="dragging"
            data-drop="discard"
            class="fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-1.5 rounded-full border px-4 py-2 text-2xs font-medium transition-colors"
            :class="
                over === 'discard' && action !== undefined
                    ? toneWash(`danger`, `border-danger`)
                    : accepts('discard')
                      ? 'border-line-strong bg-card text-muted'
                      : 'border-line bg-card text-subtle opacity-40'
            "
        >
            <Icon name="trash" class="text-2xs" />{{ t(`ui.action.discard`) }}
        </div>
        <!-- A drag is the easiest gesture here to trigger by accident, and dropping a conflicted card on Finished spends a turn. -->
        <ConfirmDialog
            :open="pendingResolve !== undefined"
            :header="t(`agents.agentsView.agentResolveConflict`)"
            :description="t(`agents.agentsView.willStartTurn`, { agent: resolveTarget?.title ?? t(`agents.agentsView.thisAgent`) })"
            :confirm-label="t(`agents.agentsView.askAgent`)"
            :destructive="false"
            @cancel="cancelResolve"
            @confirm="confirmResolve"
        >
            <p class="text-xs text-muted">{{ t(`agents.agentsView.nothingWrittenToWorkspace`) }}</p>
        </ConfirmDialog>
        <!-- On a phone a card's land asks first (useAgentDrag.pressLand), saying what goes where: its press sits under the thumb that scrolls the board. -->
        <ConfirmDialog
            :open="pendingLand !== undefined"
            :header="t(`agents.agentsView.landConfirmTitle`)"
            :description="
                pendingLand?.chosen === `reland`
                    ? t(`agents.agentsView.relandConfirmBody`, { agent: landingName })
                    : t(`agents.agentsView.landConfirmBody`, { agent: landingName })
            "
            :confirm-label="pendingLand?.chosen === `reland` ? words.landAgain : words.land"
            :destructive="false"
            tone="success"
            @cancel="cancelLand"
            @confirm="confirmLand"
        >
            <p v-if="pendingLand?.chosen === `land` && pendingLand.files !== undefined" class="text-xs text-muted">
                {{ t(`agents.agentsView.landConfirmFiles`, { count: pendingLand.files }, pendingLand.files) }}
            </p>
        </ConfirmDialog>
        <!-- Archiving loses nothing, but one tap taking a whole family off the board is not something to do unasked. -->
        <ConfirmDialog
            :open="pendingFamilyArchive !== undefined"
            :header="familyArchiveHeading"
            :description="t(`agents.agentsView.archiveFamilyKept`)"
            :confirm-label="
                t(
                    `agents.agentsView.archiveWithSubagents`,
                    { count: (pendingFamilyArchive?.children ?? 0) + 1 },
                    (pendingFamilyArchive?.children ?? 0) + 1,
                )
            "
            :destructive="false"
            @cancel="familyArchive.cancel"
            @confirm="familyArchive.confirm"
        />
        <!-- The one dialog guarding something unrecoverable: says what goes in the terms the archive has promised all along ("nothing is lost"). -->
        <ConfirmDialog
            :open="pendingPurge"
            :header="t(`agents.agentsView.deleteEveryArchivedAgent`)"
            :description="t(`agents.agentsView.archivedWillBeDeleted`, { count: archived.length }, archived.length)"
            :confirm-label="t(`agents.agentsView.deleteAgents`, { count: archived.length }, archived.length)"
            @cancel="pendingPurge = false"
            @confirm="confirmPurge"
        >
            <!-- Delete all takes everybody's, and the count alone doesn't say so: whose else goes is named before the yes. -->
            <p v-if="othersArchived.count > 0" class="text-xs font-medium text-warning" data-purge-others>
                {{
                    t(
                        `agents.agentsView.archivedOthers`,
                        { count: othersArchived.count, names: othersArchived.owners.map((owner) => owner.name).join(`, `) },
                        othersArchived.count,
                    )
                }}
            </p>
            <p class="text-xs text-muted">{{ t(`agents.agentsView.workTheyAlreadyLanded`) }}</p>
        </ConfirmDialog>
        <!-- A real card, so the drag reads as the card itself; `pointer-events-none` keeps the hit test on what's underneath it. -->
        <div v-if="dragging && dragged !== undefined" class="pointer-events-none fixed left-0 top-0 z-50 rotate-2" :style="ghostStyle">
            <div class="opacity-90 shadow-lg">
                <AgentCard :agent="dragged" :dense="narrow" :fit="fit" />
            </div>
            <p
                class="mt-1 inline-block rounded px-2 py-1 text-2xs font-medium"
                :class="action !== undefined ? 'bg-primary-fill/10 text-primary-fill border border-primary-fill/20' : 'bg-overlay text-subtle'"
            >
                {{ hint }}
            </p>
        </div>
        <!-- The board's one creating press on a phone: over the board's corner rather than in its header, where it spent a
             thumb-high row the filters needed and sat furthest from the thumb. -->
        <FloatingAction v-if="mobile && starts" icon="plus" labelled :label="words.newAgent" @click="startAgent()" />
        <!-- One menu for every card on the board; see cardMenuItems. -->
        <ContextMenu ref="cardMenu" :model="cardMenuItems" :min-width="12" />
    </div>
</template>
<style scoped>
/* Scale-fade for arrivals and removals; leaving card is absolutely positioned so siblings close ranks. */
.lane-enter-active,
.lane-leave-active {
    transition:
        transform 250ms cubic-bezier(0.2, 0, 0, 1),
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
