import type { AutomationApproval, WorkflowRun } from "@intentic/sandbox-contract";
import { t } from "@intentic/ui/i18n";
import { computed, type Ref } from "vue";
import type { FleetLane } from "../../fleet/agentStatus";
import { FINISHED_WINDOW, type FleetAgent, windowFinished } from "../../fleet/useAgents-fleet";
import { insideRun, runMatches, runsInLane, runsNeedingYou } from "../../fleet/useWorkflowRuns";
import type { DropTarget } from "../laneDrop";
import { type BoardView, windowedIn } from "./boardView";
import { boardScreen } from "./firstScreen";

// What each lane draws and what the board says about it: runs above their lane's cards, Finished capped at its window
// or standing aside for the archive a page at a time, a filter narrowing all of it; every count the header, the tail
// rows and the empty screens say is taken from those same rows, so no two of them can disagree.

export interface LaneHead {
    readonly key: FleetLane;
    readonly label: string;
    readonly dot: string;
    readonly empty: string;
}

export const laneHeads = (): readonly LaneHead[] => [
    { key: `attention`, label: t(`agents.agentsView.attention`), dot: `bg-warning`, empty: t(`agents.agentsView.nothingNeedsRightNow`) },
    { key: `active`, label: t(`agents.agentsView.active`), dot: `bg-success`, empty: t(`agents.agentsView.noAgentsWorkingStart`) },
    { key: `finished`, label: t(`agents.agentsView.finished`), dot: `bg-line-strong`, empty: t(`agents.agentsView.finishedAgentsLandWork`) },
];

// The lanes left to right, which is also the order a Shift+click range walks.
const LANE_ORDER: readonly FleetLane[] = [`attention`, `active`, `finished`];

// A lane's look while a card is in flight, one class string per state rather than composed flags: two ring widths or
// min-heights in one list would resolve by Tailwind's emit order, not by intent.
export const dropClass = (
    lane: FleetLane,
    drop: { readonly accepts: boolean; readonly archive: boolean; readonly over: DropTarget | undefined },
): string => {
    // The archive has no `data-drop` while it occupies the Finished column: it is not a lane and must not advertise being one.
    if (!drop.accepts || (lane === `finished` && drop.archive)) {
        return `min-h-24 opacity-40`;
    }
    return drop.over === lane ? `min-h-24 bg-primary-600/5 ring-2 ring-primary-500/60` : `min-h-24 ring-1 ring-line-strong/60`;
};

export interface LanesHost {
    readonly view: Readonly<Ref<BoardView>>;
    // What the scope left on the board (boardScope).
    readonly scope: {
        readonly boardLanes: Readonly<Ref<Record<FleetLane, FleetAgent[]>>>;
        readonly boardRunRows: Readonly<Ref<readonly WorkflowRun[]>>;
        readonly archivedRunRows: Readonly<Ref<readonly WorkflowRun[]>>;
        readonly ledgerRunIds: Readonly<Ref<ReadonlySet<string>>>;
        readonly scopedHeld: Readonly<Ref<readonly AutomationApproval[]>>;
    };
    // The board's filter (useAgentFilter); `partial` while the daemon's half of the answer is still out.
    readonly filter: {
        readonly active: Readonly<Ref<boolean>>;
        readonly needle: Readonly<Ref<string>>;
        readonly matches: (agent: FleetAgent) => boolean;
        readonly archivedMatches: Readonly<Ref<readonly FleetAgent[]>>;
        readonly sessionMatches: Readonly<Ref<readonly unknown[]>>;
        readonly partial: Readonly<Ref<boolean>>;
    };
    readonly drag: {
        readonly dragging: Readonly<Ref<boolean>>;
        readonly over: Readonly<Ref<DropTarget | undefined>>;
        readonly accepts: (target: DropTarget) => boolean;
    };
    // The fleet store, this sandbox's alone: its cards, its lanes and its archive.
    readonly agents: {
        readonly fleet: Readonly<Ref<readonly FleetAgent[]>>;
        readonly lanes: Readonly<Ref<Record<FleetLane, FleetAgent[]>>>;
        readonly archived: Readonly<Ref<readonly FleetAgent[]>>;
    };
    // The card wearing the ring, which the Finished window keeps wherever it sits.
    readonly selected: Readonly<Ref<string | undefined>>;
}

export const useBoardLanes = (host: LanesHost) => {
    const { view, scope, filter, agents, drag } = host;
    const windowed = computed(() => windowedIn(view.value, filter.active.value));
    // Read from the fleet, not the ledger: "blocked" is a live fact about a conversation, and the ledger knows the scheduler.
    const needingYou = computed(() => runsNeedingYou(agents.fleet.value));
    // A run under a query answers for its steps, since they have no cards of their own to answer with (runMatches).
    const runKept = (run: WorkflowRun): boolean => !filter.active.value || runMatches(run, filter.needle.value, agents.fleet.value, filter.matches);
    const liveRuns = computed(() => scope.boardRunRows.value.filter(runKept));
    const archivedRuns = computed(() => scope.archivedRunRows.value.filter(runKept));
    // The archive is a different list wearing Finished's shape, the other lanes empty while it is open; otherwise the
    // window caps Finished's runs as it caps its cards, and a capped run hides its steps too.
    const runsFor = (lane: FleetLane): WorkflowRun[] => {
        if (view.value.archive) {
            return lane === `finished` ? archivedRuns.value : [];
        }
        return runsInLane(liveRuns.value, lane, windowed.value ? FINISHED_WINDOW : Number.POSITIVE_INFINITY, needingYou.value);
    };
    // A run's steps are filed away with the run, or the archive would show one run row plus its five conversations.
    const archivedCards = computed(() => agents.archived.value.filter((agent) => !insideRun(agent, scope.ledgerRunIds.value)));
    // How many rows the archive would draw: a run with four steps counts as one row there, not five.
    const archiveSize = computed(() => archivedCards.value.length + scope.archivedRunRows.value.length);
    // Filters the whole pile first, then pages the result, never the reverse, or a match nine hundred rows down reads as none.
    const archiveRows = computed(() => (filter.active.value ? archivedCards.value.filter(filter.matches) : archivedCards.value));
    const archiveHidden = computed(() => Math.max(0, archiveRows.value.length - view.value.shown));
    const finishedWindow = computed(() =>
        windowFinished(scope.boardLanes.value.finished, windowed.value ? host.selected.value : undefined, (agent) => agent.id),
    );
    // Finished draws its window or the archive's page, the other lanes everything; a filter lifts the window first, since a
    // result set must not hide some of its own matches, while the archive keeps its page, its pile being unbounded.
    const cardsFor = (lane: FleetLane): FleetAgent[] => {
        if (lane === `finished` && view.value.archive) {
            return archiveRows.value.slice(0, view.value.shown);
        }
        const source =
            lane !== `finished` ? scope.boardLanes.value[lane] : windowed.value ? finishedWindow.value.shown : scope.boardLanes.value.finished;
        return filter.active.value ? source.filter(filter.matches) : source;
    };
    // Rows the filter kept, not rows drawn: the archive draws only a page of its matches, and the pager is not the answer.
    const keptIn = (lane: FleetLane): number =>
        (lane === `finished` && view.value.archive ? archiveRows.value.length : cardsFor(lane).length) + runsFor(lane).length;
    // What Finished's tail row folds away: the window's own count, plus the runs the same window capped.
    const hiddenFinished = computed(
        () =>
            finishedWindow.value.hidden +
            runsInLane(liveRuns.value, `finished`, Number.POSITIVE_INFINITY, needingYou.value).length -
            runsFor(`finished`).length,
    );
    // What a query found off the board, lest a filter answer "nothing" for a hit one click away; a filed run lists its steps.
    const archivedHits = computed(() => filter.archivedMatches.value.filter((agent) => !insideRun(agent, scope.ledgerRunIds.value)));
    const beyondCount = computed(() => archivedHits.value.length + filter.sessionMatches.value.length);
    // Not while the archive is the Finished column, since those cards are on screen there already.
    const beyondVisible = computed(() => filter.active.value && !view.value.archive && beyondCount.value > 0);
    const beyondLabel = computed(() => {
        const parts: string[] = [];
        if (archivedHits.value.length > 0) {
            parts.push(`${archivedHits.value.length} in the archive`);
        }
        if (filter.sessionMatches.value.length > 0) {
            parts.push(`${filter.sessionMatches.value.length} in earlier chats`);
        }
        return parts.join(` · `);
    });
    // What is on screen: a run's steps count once, as its row, and a held wake counts, so a hold alone is not an empty board.
    const total = computed(
        () =>
            LANE_ORDER.reduce((sum, lane) => sum + scope.boardLanes.value[lane].length, 0) +
            scope.boardRunRows.value.length +
            scope.scopedHeld.value.length,
    );
    // Whether anything ever happened here: an untouched draft has not, an archive has (a history, not an empty workspace).
    const started = computed(
        () =>
            LANE_ORDER.reduce((sum, lane) => sum + scope.boardLanes.value[lane].filter((agent) => agent.status !== `draft`).length, 0) +
                scope.boardRunRows.value.length +
                scope.scopedHeld.value.length +
                archiveSize.value >
            0,
    );
    const kept = computed(() => LANE_ORDER.reduce((sum, lane) => sum + keptIn(lane), 0));
    // Never claims more than it knows: "n of 40" asserts all forty were checked, false while the daemon's half is out.
    const matchTally = computed(() => (filter.partial.value ? `searching the rest…` : `${kept.value} of ${total.value}`));
    // The filter's own empty state (cards exist, none matched), never while its answer is still partial.
    const noMatches = computed(
        () => filter.active.value && !filter.partial.value && !view.value.archive && kept.value === 0 && beyondCount.value === 0,
    );
    // Finished holds exactly the archivable set by construction, so Clear shows only when it would do something.
    const clearable = computed(() => agents.lanes.value.finished.length);
    const screen = computed(() => boardScreen(started.value, total.value, view.value.archive));
    const paneOrder = computed(() => LANE_ORDER.flatMap((lane) => cardsFor(lane)));
    const laneDropClass = (lane: FleetLane): string =>
        drag.dragging.value ? dropClass(lane, { accepts: drag.accepts(lane), archive: view.value.archive, over: drag.over.value }) : ``;
    return {
        cardsFor,
        runsFor,
        needingYou,
        finishedWindow,
        paneOrder,
        archivedCards,
        archiveSize,
        archiveHidden,
        hiddenFinished,
        archivedHits,
        beyondVisible,
        beyondLabel,
        matchTally,
        noMatches,
        clearable,
        screen,
        laneDropClass,
    };
};
