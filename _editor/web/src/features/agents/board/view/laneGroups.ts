import { deviceKey, storedValue, storeValue } from "@intentic/ui/storage";
import { computed, type Ref, shallowRef } from "vue";
import type { FleetLane } from "../../../../models/agent-status/agentStatus-lanes";
import { ACTIVE_PHASES, activeGroups, type ActivePhase, goesAt } from "../../../../models/fleet/board/activePhase";
import { type Tray, trayRows } from "../../../../models/fleet/board/childFold";
import type { FleetAgent } from "../../../../models/fleet/useAgents-fleet";

// THE RUNS OF CARDS A LANE DRAWS, EACH UNDER ITS OWN HEAD. A lane is one run, save Active once it holds more than one
// phase (activePhase.ts): working, up next and drafts each draw under a head the reader can fold. A lane of twenty is
// mostly one group they are not reading right now (eight messages booked for tonight, drafts from last week), and
// folding it gives the screen back to the turns under way.

// The lanes left to right, which is also the order a Shift+click range walks.
export const LANE_ORDER: readonly FleetLane[] = [`attention`, `active`, `finished`];

export interface LaneGroup {
    // `lane` for a lane drawn as one run; the phase for one of Active's groups.
    readonly key: ActivePhase | `lane`;
    // Every card in it, folded or not.
    readonly cards: readonly FleetAgent[];
    // What it draws: every card, or folded, only the one wearing the ring (as Finished's window keeps it).
    readonly shown: readonly FleetAgent[];
    // Drawn under a head: Active holds more than one phase.
    readonly headed: boolean;
    // Its cards are drawn as rows (AgentCard `dense`) wherever the board is wide enough for the bigger card: only work in
    // flight wears that, so what waits to go by itself and a draft read a step down from the turns under way.
    readonly rows: boolean;
    // The head folds it: never under a query, whose matches must all be on screen.
    readonly foldable: boolean;
    readonly folded: boolean;
    // Up next's soonest instant (goesAt), which its folded head names: ANY_MOMENT reads as due now, Infinity as no time.
    readonly goesAt: number;
}

// WHICH GROUPS ARE FOLDED: this browser's, like a layout, and the same on every visit, as a folded tray stays folded.
// One set for every board in the window, so the all-sandboxes board folds what this one did.
const KEY = deviceKey(`intentic.board.activeFolds`);

const isPhase = (value: string): value is ActivePhase => ACTIVE_PHASES.some((phase) => phase === value);

export const readFolds = (stored: string | undefined): ReadonlySet<ActivePhase> => new Set((stored ?? ``).split(`,`).filter(isPhase));

const folds = shallowRef<ReadonlySet<ActivePhase>>(readFolds(storedValue(KEY)));

// Takes a group's key whole: a lane drawn as one run has nothing to fold.
export const toggleFold = (key: LaneGroup["key"]): void => {
    if (key === `lane`) {
        return;
    }
    const next = new Set(folds.value);
    if (!next.delete(key)) {
        next.add(key);
    }
    folds.value = next;
    storeValue(KEY, [...next].join(`,`));
};

export interface LaneGroupsHost {
    // The cards each lane draws, filtered and windowed (boardLanes.cardsFor).
    readonly cardsFor: (lane: FleetLane) => FleetAgent[];
    readonly filtering: Readonly<Ref<boolean>>;
    // The card wearing the ring, which a folded group keeps in sight.
    readonly selected: Readonly<Ref<string | undefined>>;
    // The folded groups; this browser's own when absent.
    readonly folds?: Readonly<Ref<ReadonlySet<ActivePhase>>>;
    // The tray under a card (boardTrays), whose rows a range walks too.
    readonly trayFor: (card: FleetAgent) => Tray | undefined;
}

export const useLaneGroups = (host: LaneGroupsHost) => {
    const folded = host.folds ?? folds;
    // Headed only when it holds more than one phase: a lane of one kind needs no heads to say so.
    const active = computed((): readonly LaneGroup[] => {
        const groups = activeGroups(host.cardsFor(`active`));
        const headed = groups.length > 1;
        const foldable = headed && !host.filtering.value;
        return groups.map(({ phase, cards }) => {
            const shut = foldable && folded.value.has(phase);
            return {
                key: phase,
                cards,
                shown: shut ? cards.filter((card) => card.id === host.selected.value) : cards,
                headed,
                rows: phase !== `working`,
                foldable,
                folded: shut,
                goesAt: phase === `next` ? Math.min(...cards.map(goesAt)) : Number.POSITIVE_INFINITY,
            };
        });
    });
    const groupsFor = (lane: FleetLane): readonly LaneGroup[] => {
        if (lane === `active`) {
            return active.value;
        }
        const cards = host.cardsFor(lane);
        return [{ key: `lane`, cards, shown: cards, headed: false, rows: false, foldable: false, folded: false, goesAt: Number.POSITIVE_INFINITY }];
    };
    // What is folded, as one value the lanes' motion can watch: a fold moves every card under it.
    const activeFolded = computed(() => [...folded.value].join(`,`));
    // In drawing order, each card followed by the rows its tray draws, so a range can start or end on a child; a folded
    // group's cards are not drawn, so no range opens them.
    const paneOrder = computed(() =>
        LANE_ORDER.flatMap((lane) => groupsFor(lane).flatMap((group) => group.shown.flatMap((card) => [card, ...trayRows(host.trayFor(card))]))),
    );
    return { groupsFor, activeFolded, paneOrder };
};
