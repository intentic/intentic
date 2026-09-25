<script setup lang="ts">
import { Button, ui, ContextMenu, Modal, ProjectChip, SearchBar, SegmentedControl, useDevice, useNarrow } from "@intentic/ui";
import { computed, provide, ref } from "vue";
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
import { useAuth } from "../../auth/useAuth";
import { useSandboxSharedAccess } from "../../sandbox/access/useSandboxSharedAccess";
import { useAgents } from "../fleet/useAgents";
import type { FleetAgent } from "../fleet/useAgents-fleet";
import { pendingOn } from "../fleet/useAgents-provisional";
import { fleetScope, scopeOffered } from "../fleet/fleetScope";
import { useWorkflowRuns } from "../fleet/useWorkflowRuns";
import { relativeTime } from "../../chat/models/catalog";
import { chatWide } from "../../chat/panel/chatPanelLayout";
import { openRunInChat } from "../../chat/run/openRun";
import { summonChat } from "../../chat/run/summon";
import { chatStrip } from "../../chat/panel/useChat-strip";
import LaneHeader from "../../../components/LaneHeader.vue";
import MatchLine from "../../../components/MatchLine.vue";
import AgentCard from "./cards/AgentCard.vue";
import BoardStatusBar from "../status-bar/BoardStatusBar.vue";
import { LIVE_METRICS_KEY, useLiveMetrics } from "../metrics/liveMetrics";
import { provideMainline } from "../mainline/useMainline";
import HeldWakeCard from "./cards/HeldWakeCard.vue";
import WorkflowRunCard from "./cards/WorkflowRunCard.vue";
import { useArchiveDoor } from "./view/archiveDoor";
import { useBoardCommands } from "./view/boardCommands";
import { laneHeads, useBoardLanes } from "./view/boardLanes";
import { useBoardPresses } from "./view/boardPresses";
import { followAcross, useBoardScope } from "./view/boardScope";
import { useBoardView } from "./view/boardView";
import { useCardMenu } from "./view/cardMenu";
import { useCardFocus, useCardRing } from "./view/cardSelection";
import { boardStarters } from "./view/firstScreen";
import { useLaneMotion } from "./view/laneMotion";
import { useT } from "@intentic/ui/i18n";
// Kanban across Attention/Active/Finished, pure projections of laneOf; a drop runs the action that causes a lane change
// (laneDrop), never assigns status directly. Template and wiring: what the lanes draw and cover, how the board is being
// read, the selection, the menu, the motion and the commands are the headless modules in `view/`.
const t = useT();

const router = useRouter();
const { mobile } = useDevice();
const agents = useAgents();
const { archived, archiveLoading, archiveFailure, archive, restore, notice, dismissNotice } = agents;
// Read only while this board is mounted and the reader opted in (liveMetrics.ts); the cards take theirs from here.
const liveMetrics = useLiveMetrics();
provide(LIVE_METRICS_KEY, liveMetrics);
// The main tree's own check: one read for the board, drawn in its status dock and on every card from here.
const mainline = provideMainline();
const drag = useAgentDrag();
const { dragged, dragging, draggedId, over, action, accepts, ghostStyle, pendingResolve, confirmResolve, cancelResolve } = drag;
const { resolveNow, landNow, relandNow, unwatchNow } = drag;
// Resolved live, so a rename or a status change stays visible while the dialog asks.
const resolveTarget = computed(() => (pendingResolve.value === undefined ? undefined : agents.agentById(pendingResolve.value)));
const hint = computed(() => dropHint(action.value, dragged.value, over.value));
const pendingFor = (agent: FleetAgent) => pendingOf(agent, pendingOn(agent.id, agent.sandboxId), agents.busyIds.value);
// Its field is always on the header, not behind a glyph, so nobody has to learn the board is searchable.
const filter = useAgentFilter();
const { query, needle, matchCase, active: filtering, snippetOf, sessionMatches, searching, partial: searchPartial } = filter;
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
const lanes = useBoardLanes({ view, scope, filter, drag, agents, selected: highlightId });
const { cardsFor, runsFor, needingYou, archivedCards, archiveSize, archiveHidden, hiddenFinished, archivedHits, laneDropClass } = lanes;
const { beyondVisible, beyondLabel, matchTally, noMatches, clearable, screen } = lanes;
const { setCardEl, isMovingLane, revealCard } = useLaneMotion({ lanes: scope.boardLanes, filtering, drag });
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
const { focusAgent, reviewAgent, keepAgent, closeAgent, openSession } = focus;
const { cardMenu, cardMenuItems, openCardMenu } = useCardMenu({ mobile, peeked, focus, agents });
const { announcement, pendingPurge, purging, pulsing, toggleArchive, confirmPurge } = useArchiveDoor({ view, move, agents });
const { stoppingRuns, stopRun, archiveRun, restoreRun, openRunGraph, releaseWake, synthesize } = useBoardPresses({ workflows, agents, router });
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
// Workspace facts the starters turn on, already fetched for the rail elsewhere: the board adds no fetch of its own.
const { panels: workspaceRepos } = usePanels();
const workspaceChanges = useChanges();
const starters = computed(() => boardStarters(workspaceRepos.value.length, workspaceChanges.count.value));
</script>
<!-- `relative` positions the lane-drop affordances only; the fixed drag ghost and the app's notification lane need no containing block here. -->
<!-- Kept outside the template: a comment inside it makes this multi-root, and dev patches a multi-root subtree
     unoptimized — every slotted child, closed dialogs included, redraws on every board render. -->
<template>
    <div ref="boardEl" class="relative flex h-full min-h-0 flex-col">
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
                :placeholder="t(`shared.filterByMessages`)"
                class="mx-auto max-w-full shrink-0"
                :class="narrow ? 'order-last basis-full' : 'w-72'"
            />
            <div class="flex min-w-0 flex-1 basis-0 items-center justify-end gap-2">
                <!-- Filtering shows a searching state while lane counts are partial. -->
                <span v-if="filtering" class="shrink-0 text-2xs text-muted" :aria-busy="searchPartial">{{ matchTally }}</span>
                <!-- Appears exactly when two or more chats sit side by side (the panes are the selection); opens a draft composed from their transcripts but not sent. -->
                <Button
                    v-if="chatStrip.panes.length >= 2"
                    size="small"
                    severity="secondary"
                    :disabled="synthesizing"
                    class="shrink-0"
                    @click="synthesize"
                >
                    <Icon :name="synthesizing ? `spinner` : `sparkles`" :spin="synthesizing" />{{ t(`agents.agentsView.synthesize`) }}
                    {{ chatStrip.panes.length }}
                </Button>
                <Button size="small" class="ui-button-thumb shrink-0" @click="startAgent()"> <Icon name="plus" />{{ t(`shared.newAgent`) }} </Button>
            </div>
        </div>
        <!-- Failures only: the layout shift and dismissal this costs suit something the user must read, not a routine action's receipt (which floats instead). -->
        <p v-if="notice !== undefined" class="flex shrink-0 items-center gap-2 border-b border-line bg-danger/10 px-3 py-1.5 text-2xs text-danger">
            <Icon name="exclamation-triangle" class="shrink-0 text-2xs" />
            <span class="min-w-0 flex-1">{{ notice }}</span>
            <button type="button" :aria-label="t(`ui.action.dismiss`)" class="shrink-0 rounded p-0.5 hover:bg-overlay" @click="dismissNotice">
                <Icon name="times" class="text-2xs" />
            </button>
        </p>
        <!-- What the counter's pulse can't tell a screen reader; covers every archive so the visual pill stays purely visual. -->
        <span class="sr-only" aria-live="polite">{{ announcement }}</span>
        <!-- Nothing on the board AND nothing archived is the only true empty state; an archive behind it would otherwise be a dead end with no door to it. -->
        <div v-if="screen !== 'lanes'" class="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-4 text-center">
            <!-- One heading, one sentence, nothing waiting on a daemon read: it used to swap its lower half once accounts loaded. -->
            <template v-if="screen === 'first'">
                <div class="flex w-full max-w-xl flex-col gap-2">
                    <h2 class="text-sm font-semibold text-content">{{ t(`agents.agentsView.startFirstAgent`) }}</h2>
                    <p class="text-2xs text-muted">
                        {{ t(`agents.agentsView.agentsWorkOnOwn`) }}
                    </p>
                </div>
            </template>
            <!-- A board that's been cleared, not a first run: this user knows what agents are and just needs the way back to the archive. -->
            <template v-else>
                <Icon name="sparkles" class="text-3xl text-subtle" />
                <p class="max-w-sm text-xs text-muted">
                    {{ t(`agents.agentsView.nothingOnBoardStart`) }}
                </p>
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
                <Icon name="history" class="text-2xs" />{{ archiveSize }} {{ t(`agents.agentsView.archivedAgent`) }}{{ archiveSize === 1 ? "" : "s" }}
            </button>
        </div>
        <!-- No padding of its own: the stacked board's sticky lane headers pin to top-0, and padding would leave a gap above them. -->
        <div v-else class="scrollbar-stable min-h-0 flex-1 overflow-auto">
            <!-- `content-start` stops the stacked grid's rows from stretching to fill `h-full`, which would otherwise float a lane's cards above the next header. -->
            <div
                class="grid gap-3.5 p-3.5 sm:gap-4 sm:p-4"
                :class="[narrow ? 'content-start' : 'grid-cols-3 items-start lg:gap-6 lg:p-6', noMatches ? '' : 'h-full']"
            >
                <section
                    v-for="lane in LANES"
                    :key="lane.key"
                    :data-lane="lane.key"
                    :data-drop="lane.key === 'finished' && view.archive ? undefined : lane.key"
                    class="flex min-w-0 flex-col rounded-xl transition-colors"
                    :class="[!dragging && !narrow ? 'min-h-0' : '', laneDropClass(lane.key)]"
                >
                    <!-- Finished's header doubles as the archive's window, swapping its dot/label and growing a way back; pinned while scrolling stacked. -->
                    <LaneHeader :label="lane.label" :dot="lane.dot" class="px-1" :class="narrow ? 'sticky top-0 z-10 rounded-t-xl bg-canvas' : ''">
                        <template v-if="lane.key === 'finished' && view.archive" #mark>
                            <button
                                type="button"
                                :aria-label="t(`agents.agentsView.backToFinishedAgents`)"
                                v-tooltip.bottom="t(`agents.agentsView.backToFinished`)"
                                :class="ui.iconButton(`h-4 w-4 rounded`)"
                                @click="toggleArchive"
                            >
                                <Icon name="arrow-left" class="text-2xs" />
                            </button>
                            <span class="text-2xs font-semibold uppercase tracking-wide text-muted">{{ t(`shared.archived`) }}</span>
                            <Icon v-if="archiveLoading" name="spinner" spin class="text-2xs text-muted" />
                        </template>
                        <template #actions>
                            <template v-if="lane.key === 'finished' && !view.archive">
                                <!-- Archive feedback highlights the destination counter. -->
                                <button
                                    v-if="archiveSize > 0"
                                    type="button"
                                    :aria-label="t(`agents.agentsView.openArchive`, { archiveSize })"
                                    v-tooltip.bottom="t(`agents.agentsView.takenOffBoardBranches`)"
                                    class="ui-chip shrink-0 gap-1"
                                    :class="pulsing ? `ui-chip-on ring-1 ring-primary-500/50` : ``"
                                    @click="toggleArchive"
                                >
                                    <Icon name="history" class="text-2xs" />{{ archiveSize }}
                                </button>
                                <!-- Hidden while filtering, like the drag: Clear archives the whole lane, not the filtered subset on screen. -->
                                <Button
                                    v-if="clearable > 0 && !filtering"
                                    size="small"
                                    severity="secondary"
                                    :text="true"
                                    class="ui-button-thumb shrink-0"
                                    :aria-label="t(`agents.agentsView.archiveEveryFinishedAgent`)"
                                    v-tooltip.bottom="t(`agents.agentsView.archiveAllUndo`, { clearable })"
                                    @click="archive()"
                                >
                                    {{ t(`ui.action.clear`) }}
                                </Button>
                            </template>
                            <!-- Retired-agent danger appears on hover; the dialog is the actionable warning. -->
                            <Button
                                v-if="lane.key === 'finished' && view.archive && archiveSize > 0 && !filtering"
                                size="small"
                                severity="danger"
                                :text="true"
                                class="shrink-0"
                                :aria-label="t(`agents.agentsView.deleteAllArchivedAgents`, { count: archived.length })"
                                :disabled="purging"
                                v-tooltip.bottom="t(`agents.agentsView.deleteAllPermanentlyBranches`, { count: archived.length })"
                                @click="pendingPurge = true"
                            >
                                <Icon :name="purging ? 'spinner' : 'trash'" :spin="purging" class="text-2xs" />{{ t(`agents.agentsView.deleteAll`) }}
                            </Button>
                        </template>
                    </LaneHeader>
                    <!-- Held wakes lead the lane, since a hold is wholly waiting on the user, more than anything running below it; Attention lane only. -->
                    <div v-if="lane.key === 'attention' && !view.archive && scopedHeld.length > 0" class="flex flex-col gap-2.5 pb-2.5">
                        <HeldWakeCard
                            v-for="entry in scopedHeld"
                            :key="entry.id"
                            :entry="entry"
                            :dense="narrow"
                            @approve="releaseWake(entry.id, `approve`)"
                            @reject="releaseWake(entry.id, `reject`)"
                        />
                    </div>
                    <!-- Runs sit above their lane's agent cards, since a run is a container of several of them and a container belongs above its contents, not among them. -->
                    <div v-if="runsFor(lane.key).length > 0" class="flex flex-col gap-2.5 pb-2.5">
                        <WorkflowRunCard
                            v-for="run in runsFor(lane.key)"
                            :key="run.runId"
                            :run="run"
                            :dense="narrow"
                            :selected="chatStrip.run?.runId === run.runId"
                            :needs-you="needingYou.has(run.runId)"
                            :stopping="stoppingRuns.has(run.runId)"
                            @open="openRunInChat(run)"
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
                    <div v-else class="relative flex flex-col gap-3.5 pb-2.5">
                        <!-- Skips a card whose inputs haven't changed: the roster ticks about once a second per running turn. -->
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
                                isMovingLane(agent.id),
                            ]"
                            :name="isMovingLane(agent.id) ? undefined : 'lane'"
                            :css="!isMovingLane(agent.id)"
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
                    <!-- The lane's tail, not a pager: the count is the point, and the row keeps them one press away instead of gone; hidden while filtering. -->
                    <button
                        v-if="lane.key === 'finished' && !view.archive && !filtering && hiddenFinished > 0"
                        type="button"
                        :class="ui.addTile(`mb-2.5 gap-1.5 rounded-lg py-2 text-2xs`)"
                        @click="move({ kind: 'expand' })"
                    >
                        <Icon :name="view.all ? 'chevron-up' : 'chevron-down'" class="text-2xs" />
                        {{ view.all ? t(`shared.showFewer`) : t(`shared.earlier`, { hiddenFinished }) }}
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
            <div v-if="view.beyond" class="mt-2 flex min-h-0 flex-col gap-3 overflow-auto">
                <section v-if="archivedHits.length > 0" class="flex min-w-0 flex-col gap-2.5">
                    <LaneHeader :label="t(`agents.agentsView.inArchive`)" icon="box" :count="archivedHits.length" class="px-1" />
                    <!-- Archived agents retain the branch, diff, and transcript actions. -->
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
                        <span class="text-2xs text-subtle">{{ relativeTime(session.updatedAt) }}</span>
                    </button>
                </section>
            </div>
        </div>
        <!-- The board's status bar: the main line whenever a land has been checked (work lands without waiting for it, so
             this is where its verdict is seen), and the opt-in geek metrics (Settings ▸ Appearance). At the foot, since
             the header is the board's own; a segment's panel docks above it and stays until the reader closes it. -->
        <BoardStatusBar :mainline="mainline" :metrics="liveMetrics" />
        <!-- Discard is destructive and has no lane of its own, so it only exists while a card is actually being dragged. -->
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
            <Icon name="trash" class="text-2xs" />{{ t(`shared.discard`) }}
        </div>
        <!-- A drag is the easiest gesture here to trigger by accident, and dropping a conflicted card on Finished spends a turn. -->
        <Modal :open="pendingResolve !== undefined" size="sm" :header="t(`agents.agentsView.agentResolveConflict`)" @update:open="cancelResolve">
            <p class="text-xs text-content">
                {{ t(`agents.agentsView.willStartTurn`, { agent: resolveTarget?.title ?? t(`agents.agentsView.thisAgent`) }) }}
            </p>
            <p class="mt-2 text-xs text-muted">{{ t(`agents.agentsView.nothingWrittenToWorkspace`) }}</p>
            <template #footer>
                <Button size="small" severity="secondary" :text="true" :label="t(`ui.action.cancel`)" @click="cancelResolve" />
                <Button size="small" :label="t(`agents.agentsView.askAgent`)" @click="confirmResolve" />
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
                <Button size="small" severity="secondary" :text="true" :label="t(`ui.action.cancel`)" @click="pendingPurge = false" />
                <Button
                    size="small"
                    severity="danger"
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
