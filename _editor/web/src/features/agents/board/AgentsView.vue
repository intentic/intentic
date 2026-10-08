<script setup lang="ts">
import {
    Button,
    ContextMenu,
    EmptyState,
    FloatingAction,
    Modal,
    Notice,
    ProjectChip,
    SearchBar,
    SegmentedControl,
    timeAgo,
    toneWash,
    ui,
    useDevice,
    useNarrow,
} from "@intentic/ui";
import { computed, inject, nextTick, provide, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { composeAgent, startAgent } from "../fleet/agentActions";
import { usePanels } from "../../extensions/usePanels";
import { useChanges } from "../../workspace/changes/useChanges";
import { synthesizing } from "../fleet/synthesizeSessions";
import { dropHint, pendingOf } from "./laneDrop";
import { useAgentDrag } from "./useAgentDrag";
import { useAgentFilter } from "./useAgentFilter";
import { projectScope, setProjectScope } from "../../../app/projectScope";
import { usePersonas } from "../../sandbox/personas/usePersonas";
import { useAuth } from "../../../client/auth/useAuth";
import { useSandboxSharedAccess } from "../../sandbox/access/useSandboxSharedAccess";
import { useAgents } from "../fleet/useAgents";
import { agentDisplayTitle } from "../fleet/agentStatus";
import { useVocabulary } from "../../../workbench/views/vocabulary";
import type { FleetAgent } from "../fleet/useAgents-fleet";
import { pendingOn } from "../fleet/useAgents-provisional";
import { fleetScope, scopeOffered } from "../fleet/fleetScope";
import { useWorkflowRuns } from "../fleet/useWorkflowRuns";
import { useSubagentRoster } from "../fleet/subagentRoster";
import { chatWide, showParkedChat } from "../../chat/panel/chatPanelLayout";
import { subagentOnScreen } from "../../chat/panel/subagent/subagentView";
import { openRunInChat, pointAtChat } from "../../chat/run/openRun";
import { summonChat } from "../../chat/run/summon";
import { chatStrip } from "../../chat/panel/useChat-strip";
import LaneHeader from "../../../components/LaneHeader.vue";
import MatchLine from "../../../components/MatchLine.vue";
import AgentCard from "./cards/AgentCard.vue";
import ChildRows from "./cards/ChildRows.vue";
import { CHILD_ROWS } from "./cards/childRows";
import StatusBar from "../status-bar/StatusBar.vue";
import { LIVE_METRICS_KEY, useLiveMetrics } from "../metrics/liveMetrics";
import HeldWakeCard from "./cards/HeldWakeCard.vue";
import WorkflowRunCard from "./cards/WorkflowRunCard.vue";
import { useArchiveDoor } from "./view/archiveDoor";
import { useBoardCommands } from "./view/boardCommands";
import { laneHeads, useBoardLanes } from "./view/boardLanes";
import { useBoardPresses } from "./view/boardPresses";
import { followAcross, useBoardScope } from "./view/boardScope";
import { useBoardView } from "./view/boardView";
import { useCardMenu } from "./view/cardMenu";
import { useFamilyArchive } from "./view/familyArchive";
import { useCardFocus, useCardRing } from "./view/cardSelection";
import { useFoundCard } from "./view/foundCard";
import { boardStarters } from "./view/firstScreen";
import { useRowReveal } from "@intentic/ui/motion";
import { laneOrder, useLaneMotion } from "./view/laneMotion";
import { useT } from "@intentic/ui/i18n";
import { useWallpaper } from "../../../skins/useWallpaper";
// Kanban across Attention/Active/Finished, pure projections of laneOf; a drop runs the action that causes a lane change
// (laneDrop), never assigns status directly. Template and wiring: what the lanes draw and cover, how the board is being
// read, the selection, the menu, the motion and the commands are the headless modules in `view/`.
const t = useT();

const router = useRouter();
const { mobile, coarse } = useDevice();
const agents = useAgents();
const { archived, archiveLoading, archiveFailure, archive, restore, notice, dismissNotice } = agents;
// The desktop shell reads the geek metrics for its status bar and hands them down. A phone has no shell bar, so there the
// board reads its own and draws its own bar at its foot (liveMetrics.ts). Either way the cards take theirs from here.
const shellMetrics = inject(LIVE_METRICS_KEY, undefined);
const liveMetrics = shellMetrics ?? useLiveMetrics();
const ownStatusBar = shellMetrics === undefined;
provide(LIVE_METRICS_KEY, liveMetrics);
const drag = useAgentDrag();
const { dragged, dragging, draggedId, over, action, accepts, ghostStyle, pendingResolve, confirmResolve, cancelResolve } = drag;
const { resolveNow, pressLand, pendingLand, confirmLand, cancelLand, unwatchNow } = drag;
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
const filterField = ref<InstanceType<typeof SearchBar> | undefined>(undefined);
const { view, move } = useBoardView(needle);
const workflows = useWorkflowRuns();
const { personas } = usePersonas();
const { user } = useAuth();
const { sharedAccess } = useSandboxSharedAccess();
const scope = useBoardScope({ agents, runs: workflows.runs, personas, me: computed(() => user.value?.email), sharedAccess });
const { scopeOptions, ownerOptions, ownerScope, projectHidden, scopedHeld } = scope;
followAcross();
const ring = useCardRing({ mobile, strip: chatStrip, wide: chatWide, runs: workflows.runs });
const { highlightId, inPane, peeked } = ring;
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
const lanes = useBoardLanes({ view, scope, filter, drag, agents, roster, selected: highlightId });
const { cardsFor, runsFor, needingYou, archivedCards, archiveSize, archiveHidden, hiddenFinished, archivedHits, laneDropClass } = lanes;
const { childrenOf, subagentsOf, callOf, familyOf, familyIds } = lanes;
const { beyondVisible, beyondLabel, matchTally, noMatches, clearable, screen } = lanes;
// What opens and shuts the trays under the cards (ChildRows' `shown`): the ring, the panes beside it, a subagent's
// transcript on screen. A render that moves any of it is one the lanes' motion measures across.
const folds = (): string => `${highlightId.value}|${chatStrip.value.panes.join(`,`)}|${subagentShown.value?.id}`;
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
const { focusAgent, focusSubagent, drillIn, keepAgent, closeAgent, openSession } = focus;
// The card the filter names by its id: the lanes lead with it, it is scrolled to, and Enter in the field opens it as a
// click would; with nothing named, Enter does what it always did, which is nothing.
const { found, openFound } = useFoundCard({ filter, lanes, move, reveal: revealCard, open: (agent) => focusAgent(agent) });
const onFieldEnter = (event: KeyboardEvent): void => {
    // Enter that confirms an IME composition is the composition's, not a request to open anything.
    if (event.isComposing) {
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
const { pending: pendingFamilyArchive } = familyArchive;
const { cardMenu, cardMenuItems, openCardMenu } = useCardMenu({
    mobile,
    peeked,
    focus,
    agents: {
        stopWatching: agents.stopWatching,
        // No ids is the lane's Clear, which already names every finished card there is.
        archive: familyArchive.requestIds,
        restore: (ids) => restore(withFamilies(ids)),
    },
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
const { stoppingRuns, stopRun, archiveRun, restoreRun, openRun, openRunGraph, releaseWake, synthesize } = useBoardPresses({
    workflows,
    agents,
    router,
    chat: {
        strip: chatStrip,
        // Where ChatPanel draws a run's diagram: a wide panel, on a desktop.
        diagram: computed(() => chatWide.value && !mobile.value),
        mobile,
        // As an agent card's press does (cardSelection.focusAgent): a parked chat opens /chat to show what moved.
        follow: (run) => {
            void openRunInChat(run);
            showParkedChat();
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
// The board's own width, measured (useNarrow): a container query's `container-type` would contain the fixed drag ghost.
const NARROW_BOARD_REM = 48;
const boardEl = ref<HTMLElement | undefined>(undefined);
const narrow = useNarrow(boardEl, NARROW_BOARD_REM);
const LANES = computed(laneHeads);
// A wallpaper shows through the lanes (wallpapers.css), so their headers drop the canvas band they pin on; a pinned
// header with nothing behind it would slide over the cards scrolling under it, so they scroll away with the lane.
const { wallpaper } = useWallpaper();
const papered = computed(() => wallpaper.value !== `none`);
// Folding Finished shrinks the board under the reader, and from its tail that drops them far below the lane; its header
// is brought back to the top instead, so the fold lands where the lane starts.
const toggleFinished = async (): Promise<void> => {
    const folding = view.value.all;
    move({ kind: `expand` });
    if (!folding) {
        return;
    }
    await nextTick();
    const lane = boardEl.value?.querySelector<HTMLElement>(`[data-lane="finished"]`);
    const scroller = lane?.closest<HTMLElement>(`.overflow-auto`);
    if (lane && scroller && lane.getBoundingClientRect().top < scroller.getBoundingClientRect().top) {
        lane.scrollIntoView({ block: `start` });
    }
};
// Workspace facts the starters turn on, already fetched for the rail elsewhere: the board adds no fetch of its own.
const { panels: workspaceRepos } = usePanels();
const workspaceChanges = useChanges();
const starters = computed(() => boardStarters(workspaceRepos.value.length, workspaceChanges.count.value));

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
<!-- Kept outside the template: a comment inside it makes this multi-root, and dev patches a multi-root subtree
     unoptimized — every slotted child, closed dialogs included, redraws on every board render. -->
<template>
    <div ref="boardEl" class="agents-board relative flex h-full min-h-0 flex-col">
        <!-- The filter remains usable at narrow /agents widths. -->
        <div class="view-header view-header-wrap flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1">
            <div class="flex min-w-0 flex-1 basis-0 items-center gap-2">
                <!-- Drawn only when more than one sandbox exists (scopeOffered): a switch whose two settings look identical teaches the reader to ignore controls. -->
                <SegmentedControl v-if="scopeOffered" v-model="fleetScope" :options="scopeOptions" class="shrink-0" />
                <!-- Whose sessions the board shows; hidden when access names only one person, since Everyone and Mine say the same thing. -->
                <SegmentedControl v-if="user !== null && sharedAccess" v-model="ownerScope" :options="ownerOptions" size="xs" wrap class="shrink-0" />
                <!-- The open project, and the way out of it: the same scope the workspace chip clears, so both say the same thing. -->
                <ProjectChip :project="projectScope" :hidden="projectHidden" noun="agents" @clear="setProjectScope(undefined)" />
            </div>
            <SearchBar
                ref="filterField"
                v-model="query"
                v-model:match-case="matchCase"
                variant="field"
                clearable
                :busy="searching"
                :aria-label="t(`agents.agentsView.filterAgentsByMessages`)"
                :placeholder="t(`agents.words.filterByMessages`)"
                class="mx-auto max-w-full shrink-0"
                :class="narrow ? 'order-last basis-full' : 'w-72'"
                @keydown.enter="onFieldEnter"
            />
            <div class="flex min-w-0 flex-1 basis-0 items-center justify-end gap-2">
                <!-- Filtering shows a searching state while lane counts are partial. -->
                <span v-if="filtering" class="shrink-0 text-2xs text-muted" :aria-busy="searchPartial">{{ matchTally }}</span>
                <!-- Appears exactly when two or more chats sit side by side (the panes are the selection); opens a draft composed from their transcripts but not sent. -->
                <Button
                    v-if="chatStrip.panes.length >= 2"
                    size="small"
                    tier="boring"
                    :disabled="synthesizing"
                    class="shrink-0"
                    @click="synthesize"
                >
                    <Icon :name="synthesizing ? `spinner` : `sparkles`" :spin="synthesizing" />{{ t(`agents.agentsView.synthesize`) }}
                    {{ chatStrip.panes.length }}
                </Button>
                <!-- A phone floats it over the board instead (below), where the thumb is and the filters get the row. -->
                <Button v-if="!mobile" size="small" thumb @click="startAgent()">
                    <Icon name="plus" />{{ t(`chat.words.newAgent`) }}
                </Button>
            </div>
        </div>
        <!-- Failures only: the layout shift and dismissal this costs suit something the user must read, not a routine action's receipt (which floats instead). -->
        <Notice v-if="notice !== undefined" tone="danger" size="sm" strip :dismiss-label="t(`ui.action.dismiss`)" @dismiss="dismissNotice">
            {{ notice }}
        </Notice>
        <!-- What the counter's pulse can't tell a screen reader; covers every archive so the visual pill stays purely visual. -->
        <span class="sr-only" aria-live="polite">{{ announcement }}</span>
        <span class="sr-only" aria-live="polite">{{ foundAnnouncement }}</span>
        <!-- Nothing on the board AND nothing archived is the only true empty state; an archive behind it would otherwise be a dead end with no door to it. -->
        <!-- First run: one heading, one sentence, nothing waiting on a daemon read (it used to swap its lower half once
             accounts loaded). Cleared: this user knows what agents are and just needs the way back to the archive. -->
        <EmptyState
            v-if="screen !== 'lanes'"
            :icon="screen === 'first' ? undefined : 'sparkles'"
            :line="screen === 'first' ? t(`agents.agentsView.agentsWorkOnOwn`) : t(`agents.agentsView.nothingOnBoardStart`)"
            class="min-h-0 flex-1 gap-4 p-4"
        >
            <template v-if="screen === 'first'" #title>
                <h2 class="font-semibold text-content">{{ t(`agents.agentsView.startFirstAgent`) }}</h2>
            </template>
            <!-- Tasks read off the actual workspace (see `starters`), filling the composer rather than dispatching, so the user sends their own first turn. -->
            <div v-if="screen === 'first' && starters.length > 0" class="flex max-w-xl flex-wrap items-center justify-center gap-1.5">
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
                <Icon name="history" class="text-2xs" />{{ t(`agents.agentsView.archivedAgents`, { count: archiveSize }, archiveSize) }}
            </button>
        </EmptyState>
        <!-- No padding of its own: the stacked board's sticky lane headers pin to top-0, and padding would leave a gap above them. -->
        <div v-else class="scrollbar-stable min-h-0 flex-1 overflow-auto">
            <!-- `content-start` stops the stacked grid's rows from stretching to fill `h-full`, which would otherwise float a lane's cards above the next header. -->
            <!-- A phone's board ends with room for the floating New agent, so its last card never sits under the press. -->
            <div
                class="grid gap-3.5 p-3.5 sm:gap-4 sm:p-4"
                :class="[narrow ? 'content-start' : 'grid-cols-3 items-start lg:gap-6 lg:p-6', noMatches ? '' : 'h-full', mobile ? 'pb-24' : '']"
            >
                <section
                    v-for="lane in LANES"
                    :key="lane.key"
                    :data-lane="lane.key"
                    :data-reveal-column="narrow ? undefined : ``"
                    :data-drop="lane.key === 'finished' && view.archive ? undefined : lane.key"
                    class="flex min-w-0 flex-col rounded-xl transition-colors"
                    :class="[!dragging && !narrow ? 'min-h-0' : '', laneDropClass(lane.key)]"
                >
                    <!-- Finished's header doubles as the archive's window, swapping its label and growing a way back; pinned while scrolling, unless a wallpaper shows through. -->
                    <LaneHeader :label="lane.label" class="rounded-t-xl px-1" :class="papered ? '' : 'sticky top-0 z-10 bg-canvas'">
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
                            <span class="text-2xs font-semibold uppercase tracking-wide text-muted">{{ t(`shared.archived`) }}</span>
                            <Icon v-if="archiveLoading" name="spinner" spin class="text-2xs text-muted" />
                        </template>
                        <template #actions>
                            <template v-if="lane.key === 'finished' && !view.archive">
                                <!-- The expanded lane's fold, pinned with the header: the tail row's twin sits a long scroll down. -->
                                <button
                                    v-if="view.all && !filtering && hiddenFinished > 0"
                                    type="button"
                                    class="ui-chip shrink-0 gap-1"
                                    :aria-label="t(`ui.action.showFewer`)"
                                    @click="toggleFinished"
                                >
                                    <Icon name="chevron-up" class="text-2xs" />{{ t(`ui.action.showFewer`) }}
                                </button>
                                <!-- Archive feedback highlights the destination counter. -->
                                <button
                                    v-if="archiveSize > 0"
                                    type="button"
                                    :aria-label="t(`agents.agentsView.openArchive`, { archiveSize })"
                                    v-tooltip.bottom="{ title: t(`shared.archived`), rows: [{ label: t(`shared.agents`), value: archiveSize }], note: t(`agents.words.allKept`) }"
                                    :class="ui.chip({ on: pulsing }, `shrink-0 gap-1`, pulsing && `ring-1 ring-primary-500/50`)"
                                    @click="toggleArchive"
                                >
                                    <Icon name="history" class="text-2xs" />{{ archiveSize }}
                                </button>
                                <!-- Hidden while filtering, like the drag: Clear archives the whole lane, not the filtered subset on screen. -->
                                <Button
                                    v-if="clearable > 0 && !filtering"
                                    size="small"
                                    tier="quiet" thumb
                                    class="shrink-0"
                                    :aria-label="t(`agents.agentsView.archiveEveryFinishedAgent`)"
                                    v-tooltip.bottom="{ title: t(`agents.agentsView.archiveAll`), rows: [{ label: t(`shared.agents`), value: clearable }], note: t(`agents.words.undoable`) }"
                                    @click="archive()"
                                >
                                    {{ t(`ui.action.clear`) }}
                                </Button>
                            </template>
                            <!-- Retired-agent danger appears on hover; the dialog is the actionable warning. -->
                            <Button
                                v-if="lane.key === 'finished' && view.archive && archiveSize > 0 && !filtering"
                                size="small"
                                tier="quiet" tone="danger"
                                class="shrink-0"
                                :aria-label="t(`agents.agentsView.deleteAllArchivedAgents`, { count: archived.length })"
                                :disabled="purging"
                                v-tooltip.bottom="{ title: t(`agents.agentsView.deleteAll`), rows: [{ label: t(`shared.agents`), value: archived.length }], note: t(`agents.words.cantUndo`) }"
                                @click="pendingPurge = true"
                            >
                                <Icon :name="purging ? 'spinner' : 'trash'" :spin="purging" class="text-2xs" />{{ t(`agents.agentsView.deleteAll`) }}
                            </Button>
                        </template>
                    </LaneHeader>
                    <!-- Held wakes lead the lane, since a hold is wholly waiting on the user, more than anything running below it; Attention lane only. -->
                    <div v-if="lane.key === 'attention' && !view.archive && scopedHeld.length > 0" class="flex flex-col gap-3.5 pb-2.5">
                        <HeldWakeCard
                            v-for="entry in scopedHeld"
                            :key="entry.id"
                            data-reveal
                            :entry="entry"
                            :dense="narrow"
                            @approve="releaseWake(entry.id, `approve`)"
                            @reject="releaseWake(entry.id, `reject`)"
                        />
                    </div>
                    <!-- Runs sit above their lane's agent cards, since a run is a container of several of them and a container belongs above its contents, not among them. -->
                    <div v-if="runsFor(lane.key).length > 0" class="flex flex-col gap-3.5 pb-2.5">
                        <WorkflowRunCard
                            v-for="run in runsFor(lane.key)"
                            :key="run.runId"
                            data-reveal
                            :run="run"
                            :dense="narrow"
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
                    <!-- A failed read is said in place of "nothing archived", which would claim the archive is empty. -->
                    <p
                        v-if="lane.key === 'finished' && view.archive && archivedCards.length === 0 && runsFor('finished').length === 0"
                        class="px-1 pb-3 text-2xs"
                        :class="archiveFailure === undefined ? 'text-subtle' : 'text-danger'"
                        :role="archiveFailure === undefined ? undefined : 'alert'"
                    >
                        {{
                            archiveFailure ??
                            (view.purged ? t(`agents.agentsView.archiveEmptiedFinishedAgents`) : t(`agents.agentsView.nothingArchivedYetFinished`))
                        }}
                    </p>
                    <!-- An emptied lane keeps its header rather than collapsing: three columns shrinking to one mid-keystroke would jump the whole board under the cursor. -->
                    <p
                        v-else-if="
                            cardsFor(lane.key).length === 0 && runsFor(lane.key).length === 0 && !(lane.key === 'attention' && scopedHeld.length > 0)
                        "
                        class="px-1 pb-3 text-2xs text-subtle"
                    >
                        {{ filtering ? t(`agents.agentsView.noMatchesInLane`) : lane.empty }}
                    </p>
                    <div v-else class="relative flex flex-col gap-4.5 pb-2.5">
                        <!-- Skips a card whose inputs haven't changed: the roster ticks about once a second per running turn. -->
                        <Transition
                            v-for="agent in cardsFor(lane.key)"
                            :key="agent.id"
                            v-memo="[
                                agent,
                                narrow,
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
                            ]"
                            :name="isMovingLane(agent.id) ? undefined : 'lane'"
                            :css="!isMovingLane(agent.id)"
                            :appear="boardDrawn"
                        >
                            <!-- A card and the children riding under it (ChildRows), one unit to the lane: they arrive, leave, space and slide as one (laneMotion). -->
                            <div class="flex flex-col" data-fold-unit data-reveal>
                                <AgentCard
                                    :ref="(el) => setCardEl(agent.id, el)"
                                    :agent="agent"
                                    :dense="narrow"
                                    :dragging="draggedId === agent.id && dragging"
                                    :pending="pendingFor(agent)"
                                    :selected="ringed(agent.id)"
                                    :peek="peeked(agent.id)"
                                    :match="snippetOf(agent)"
                                    :id-match="idMatchOf(agent)"
                                    :query="needle"
                                    :match-case="matchCase"
                                    :family="familyOf(agent).length"
                                    :placed="lane.key"
                                    :call="callOf(agent)"
                                    @open="(event) => focusAgent(agent, event)"
                                    @keep="keepAgent(agent)"
                                    @review="drillIn(agent)"
                                    @resolve="resolveNow(agent.id, agent.sandboxId)"
                                    @land="pressLand(agent, `land`, mobile)"
                                    @reland="pressLand(agent, `reland`, mobile)"
                                    @unwatch="unwatchNow(agent.id, agent.sandboxId)"
                                    @stop-job="(jobId) => agents.stopJob(agent.id, jobId)"
                                    @archive="familyArchive.request(agent)"
                                    @restore="restore(familyIds(agent))"
                                    @close="closeAgent(agent)"
                                    @grab="(event, card) => grabCard(event, agent, card)"
                                    @contextmenu.prevent.stop="openCardMenu(agent, $event)"
                                />
                                <ChildRows
                                    :agent="agent"
                                    :focused="ringed(agent.id)"
                                    :live="!narrow && lane.key !== `finished`"
                                    :class="draggedId === agent.id && dragging ? `opacity-40` : ``"
                                />
                            </div>
                        </Transition>
                    </div>
                    <!-- The lane's tail, not a pager: the count is the point, and the row keeps them one press away instead of gone; hidden while filtering. -->
                    <button
                        v-if="lane.key === 'finished' && !view.archive && !filtering && hiddenFinished > 0"
                        type="button"
                        :class="ui.addTile(`mb-2.5 gap-1.5 rounded-lg py-2 text-2xs`)"
                        @click="toggleFinished"
                    >
                        <Icon :name="view.all ? 'chevron-up' : 'chevron-down'" class="text-2xs" />
                        {{ view.all ? t(`ui.action.showFewer`) : t(`ui.action.showEarlier`, { count: hiddenFinished }) }}
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
                </section>
            </div>
            <!-- The filter's own empty state, not the board's: agents exist, just none matched. -->
            <p v-if="noMatches" class="px-4 pb-6 text-center text-2xs text-subtle">
                <template v-if="matchCase">
                    {{ t(`agents.agentsView.noAgentMentions`) }}{{ query.trim() }}{{ t(`agents.agentsView.thoseExactCapitals`) }}
                    <button type="button" class="font-medium text-link underline-offset-2 hover:underline" @click="matchCase = false">
                        {{ t(`agents.agentsView.ignoreCase`) }}
                    </button>
                </template>
                <template v-else>{{ t(`agents.agentsView.noAgentYoursMentions`, { trim: query.trim() }) }}</template>
            </p>
        </div>
        <!-- What the query found off the board: the Finished window and the archive both hide agents the filter would otherwise miss entirely. -->
        <div v-if="beyondVisible" class="flex max-h-[50%] shrink-0 flex-col border-t border-line px-3 pb-3 pt-2" :class="narrow ? '' : 'lg:px-4'">
            <button
                type="button"
                class="flex w-full shrink-0 items-center gap-2 rounded-lg px-1 py-1 text-2xs text-muted transition-colors hover:text-content"
                :aria-expanded="view.beyond"
                @click="move({ kind: 'beyond' })"
            >
                <Icon name="search" class="shrink-0 text-2xs text-subtle" />
                <span class="min-w-0 flex-1 truncate text-left">{{ beyondLabel }}</span>
                <span class="shrink-0 font-medium text-link">{{ view.beyond ? t(`agents.agentsView.hide`) : t(`agents.agentsView.show`) }}</span>
                <Icon :name="view.beyond ? 'chevron-up' : 'chevron-down'" class="shrink-0 text-2xs" />
            </button>
            <!-- Padded by the found card's halo (a 2px outline 2px out), which the scroll box would otherwise clip. -->
            <div v-if="view.beyond" class="-mx-1 mt-2 flex min-h-0 flex-col gap-3 overflow-auto px-1 pb-1">
                <section v-if="archivedHits.length > 0" class="flex min-w-0 flex-col gap-3.5">
                    <LaneHeader :label="t(`agents.agentsView.inArchive`)" icon="box" :count="archivedHits.length" class="px-1" />
                    <!-- Archived agents retain the branch, diff, and transcript actions. -->
                    <div class="grid gap-3.5" :class="narrow ? '' : 'grid-cols-3 items-start lg:gap-4.5'">
                        <AgentCard
                            v-for="agent in archivedHits"
                            :key="agent.id"
                            :agent="agent"
                            :dense="narrow"
                            :pending="pendingFor(agent)"
                            :selected="ringed(agent.id)"
                            :match="snippetOf(agent)"
                            :id-match="idMatchOf(agent)"
                            :query="needle"
                            :match-case="matchCase"
                            @open="(event) => focusAgent(agent, event)"
                            @review="drillIn(agent)"
                            @restore="restore([agent.id])"
                            @unwatch="unwatchNow(agent.id)"
                            @stop-job="(jobId) => agents.stopJob(agent.id, jobId)"
                            @contextmenu.prevent.stop="openCardMenu(agent, $event)"
                        />
                    </div>
                </section>
                <section v-if="sessionMatches.length > 0" class="flex min-w-0 flex-col gap-1">
                    <LaneHeader :label="t(`agents.agentsView.inEarlierChats`)" icon="history" :count="sessionMatches.length" class="px-1" />
                    <!-- Conversations no agent entry owns; with no card to draw, they read as history rows and open as tabs, the same act the History menu performs. -->
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
                        <span class="text-2xs text-subtle">{{ timeAgo(session.updatedAt, { days: true }) }}</span>
                    </button>
                </section>
            </div>
        </div>
        <!-- Where no shell bar carries them (a phone), the opt-in geek metrics (Settings ▸ Appearance) at the board's foot;
             their panel docks above it and stays until the reader closes it. -->
        <StatusBar v-if="ownStatusBar" :metrics="liveMetrics" />
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
        <Modal :open="pendingResolve !== undefined" size="sm" :header="t(`agents.agentsView.agentResolveConflict`)" @update:open="cancelResolve">
            <p class="text-xs text-content">
                {{ t(`agents.agentsView.willStartTurn`, { agent: resolveTarget?.title ?? t(`agents.agentsView.thisAgent`) }) }}
            </p>
            <p class="mt-2 text-xs text-muted">{{ t(`agents.agentsView.nothingWrittenToWorkspace`) }}</p>
            <template #footer>
                <Button size="small" tier="quiet" :label="t(`ui.action.cancel`)" @click="cancelResolve" />
                <Button size="small" :label="t(`agents.agentsView.askAgent`)" @click="confirmResolve" />
            </template>
        </Modal>
        <!-- On a phone a card's land asks first (useAgentDrag.pressLand), saying what goes where: its press sits under the thumb that scrolls the board. -->
        <Modal :open="pendingLand !== undefined" size="sm" :header="t(`agents.agentsView.landConfirmTitle`)" @update:open="cancelLand">
            <p class="text-xs text-content">
                {{
                    pendingLand?.chosen === `reland`
                        ? t(`agents.agentsView.relandConfirmBody`, { agent: landingName })
                        : t(`agents.agentsView.landConfirmBody`, { agent: landingName })
                }}
            </p>
            <p v-if="pendingLand?.chosen === `land` && pendingLand.files !== undefined" class="mt-2 text-xs text-muted">
                {{ t(`agents.agentsView.landConfirmFiles`, { count: pendingLand.files }, pendingLand.files) }}
            </p>
            <template #footer>
                <Button size="small" tier="quiet" :label="t(`ui.action.cancel`)" @click="cancelLand" />
                <Button size="small" tone="success" :label="pendingLand?.chosen === `reland` ? words.landAgain : words.land" @click="confirmLand" />
            </template>
        </Modal>
        <!-- Archiving loses nothing, but one tap taking a whole family off the board is not something to do unasked. -->
        <Modal
            :open="pendingFamilyArchive !== undefined"
            size="sm"
            :header="
                t(
                    `agents.agentsView.archiveFamily`,
                    { title: pendingFamilyArchive?.title ?? ``, count: pendingFamilyArchive?.children ?? 0 },
                    pendingFamilyArchive?.children ?? 0,
                )
            "
            @update:open="familyArchive.cancel"
        >
            <p class="text-xs text-muted">{{ t(`agents.agentsView.archiveFamilyKept`) }}</p>
            <template #footer>
                <Button size="small" tier="quiet" :label="t(`ui.action.cancel`)" @click="familyArchive.cancel" />
                <Button
                    size="small"
                    :label="
                        t(`agents.agentsView.archiveWithSubagents`, { count: (pendingFamilyArchive?.children ?? 0) + 1 }, (pendingFamilyArchive?.children ?? 0) + 1)
                    "
                    @click="familyArchive.confirm"
                />
            </template>
        </Modal>
        <!-- The one dialog guarding something unrecoverable: says what goes in the terms the archive has promised all along ("nothing is lost"). -->
        <Modal :open="pendingPurge" size="sm" :header="t(`agents.agentsView.deleteEveryArchivedAgent`)" @update:open="pendingPurge = false">
            <p class="text-xs text-content">
                {{ t(`agents.agentsView.archivedWillBeDeleted`, { count: archived.length }, archived.length) }}
            </p>
            <p class="mt-2 text-xs text-muted">
                {{ t(`agents.agentsView.workTheyAlreadyLanded`) }}
            </p>
            <template #footer>
                <Button size="small" tier="quiet" :label="t(`ui.action.cancel`)" @click="pendingPurge = false" />
                <Button
                    size="small"
                    tone="danger"
                    :label="t(`agents.agentsView.deleteAgents`, { count: archived.length }, archived.length)"
                    @click="confirmPurge"
                />
            </template>
        </Modal>
        <!-- A real card, so the drag reads as the card itself; `pointer-events-none` keeps the hit test on what's underneath it. -->
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
        <!-- The board's one creating press on a phone: over the board's corner rather than in its header, where it spent a
             thumb-high row the filters needed and sat furthest from the thumb. -->
        <FloatingAction v-if="mobile" icon="plus" labelled :label="t(`chat.words.newAgent`)" @click="startAgent()" />
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
