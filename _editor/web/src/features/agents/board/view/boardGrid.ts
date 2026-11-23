import { useNarrow } from "@intentic/ui";
import { computed, nextTick, type Ref, ref, watch } from "vue";
import type { FleetLane } from "../../../../models/agent-status/agentStatus-lanes";
import type { BoardView, ViewEvent } from "./boardView";
import type { LaneContent } from "./phoneLanes";

// The board's own width, measured (useNarrow): a container query's `container-type` would contain the fixed drag ghost.
// THREE SHAPES BY WIDTH. Under 48rem the lanes stack. From there to 56rem (a tablet, a narrow window) three columns would
// leave a card under 260px, where its title gives way to the standing beside it; so the board is two columns there: the
// lanes about work in flight (Attention over Active, both short) share the first, and Finished, the long ledger, has the
// second. Reading order is the same in all shapes: Attention, Active, Finished. Until 2026-11-23 two columns held to 72rem,
// set when a live card's title was 14px; at the chat's 12px a 270px card wraps its title to two readable lines, and a
// 1600px screen beside the docked chat was left with two wide columns and a third of the board empty.
const NARROW_BOARD_REM = 48;
const PAIRED_BOARD_REM = 56;
// From here three columns give each lane some 330px, enough for a card's title on two lines beside its standing: reshaping
// a board this wide would only stretch the cards (two columns of 500px put a card's time far from its title), so a roomy
// board keeps its three lanes whatever they hold. 66rem is a 1600px screen beside the chat at its default width; it was
// 90rem until 2026-11-23, which kept that screen in two columns whenever a lane was empty (pinned in boardGrid.test.ts).
export const ROOMY_BOARD_REM = 66;

// AND BY WHAT THE LANES HOLD. On a wide board an empty lane still took a third of it for one sentence, while the lane
// with something to read cut its titles short beside it. So an empty lane gives its column away and says its sentence
// on its header's line:
// - paired:  Attention or Active empty: the two share the first column, Finished has the second.
// - tucked:  Finished empty: Attention has the first column, Active the second with Finished's line under it.
// - ledger:  only one lane holds anything: the empty two share a line on top and that lane spans the board under them,
//            its cards in two columns.
// A board with nothing in any lane keeps its width's layout, each lane saying what will land in it, and so does a roomy
// one (ROOMY_BOARD_REM), whose three columns are not cramped by anything.
export type BoardLayout = `stacked` | `three` | `paired` | `tucked` | `ledger`;

// Which lanes have nothing to draw (phoneLanes' content is not `rows`: no cards, runs, held wakes or launches).
export type QuietLanes = Readonly<Record<FleetLane, boolean>>;

export const LOUD = { attention: false, active: false, finished: false } satisfies QuietLanes;

export interface LaneLayout {
    readonly kind: BoardLayout;
    // The ledger's one lane with anything in it.
    readonly wide?: FleetLane;
}

const LANES: readonly FleetLane[] = [`attention`, `active`, `finished`];

export const boardLayout = (narrow: boolean, underThree: boolean, quiet: QuietLanes, roomy = false): LaneLayout => {
    if (narrow) {
        return { kind: `stacked` };
    }
    if (roomy) {
        return { kind: `three` };
    }
    const full = LANES.filter((lane) => !quiet[lane]);
    if (full.length === 1) {
        return { kind: `ledger`, wide: full[0] };
    }
    if (full.length === 2) {
        return { kind: quiet.finished ? `tucked` : `paired` };
    }
    return { kind: underThree ? `paired` : `three` };
};

const cornerLane = ({ kind, wide }: LaneLayout): FleetLane => (kind === `ledger` && wide !== undefined ? wide : `finished`);

// Where each lane sits in the paired shape: Finished spans both rows of the second column, so the first column's rows
// size to Attention and Active alone (`grid-rows-[auto_1fr]`: the second row takes whatever Finished needs past them).
// That needs the rows sized by what they hold: held to the board's height (`h-full`) with the lanes allowed to shrink
// (`min-h-0`), as three columns in one row can be, a long Attention lane left Active a 0px row and drew it over its cards;
// so the paired grid only starts at the board's height (`min-h-full`) and its lanes keep their own. The tucked and ledger
// layouts are the same grid with other cells.
const PLACE = {
    paired: { attention: `col-start-1 row-start-1`, active: `col-start-1 row-start-2`, finished: `col-start-2 row-span-2 row-start-1` },
    tucked: { attention: `col-start-1 row-span-2 row-start-1`, active: `col-start-2 row-start-1`, finished: `col-start-2 row-start-2` },
} satisfies Record<string, Record<FleetLane, string>>;

// The ledger by its wide lane: the other two on the first row in reading order, the wide one spanning the second.
const LEDGER_PLACE = {
    attention: { attention: `col-span-2 row-start-2`, active: `col-start-1 row-start-1`, finished: `col-start-2 row-start-1` },
    active: { attention: `col-start-1 row-start-1`, active: `col-span-2 row-start-2`, finished: `col-start-2 row-start-1` },
    finished: { attention: `col-start-1 row-start-1`, active: `col-start-2 row-start-1`, finished: `col-span-2 row-start-2` },
} satisfies Record<FleetLane, Record<FleetLane, string>>;

const GRID = {
    stacked: `content-start`,
    three: `grid-cols-3 items-start lg:gap-6 lg:p-6`,
    paired: `grid-cols-2 grid-rows-[auto_1fr] items-start lg:gap-6 lg:p-6`,
    tucked: `grid-cols-2 grid-rows-[auto_1fr] items-start lg:gap-6 lg:p-6`,
    ledger: `grid-cols-2 grid-rows-[auto_1fr] items-start gap-y-2 lg:gap-x-6 lg:p-6`,
} satisfies Record<BoardLayout, string>;

export interface BoardGridHost {
    readonly board: Ref<HTMLElement | undefined>;
    readonly view: Readonly<Ref<BoardView>>;
    readonly move: (event: ViewEvent) => void;
    // What each lane holds (phoneLanes.ts), and whether it says its empty line.
    readonly content: (lane: FleetLane) => LaneContent;
    readonly saysEmpty: (lane: FleetLane) => boolean;
    // A query empties lanes keystroke by keystroke, and the board must not reshape under the cursor, so while one is typed
    // the layout keeps the emptiness it last read at rest. A first run and an unread roster have no lanes to judge yet,
    // so they keep the width's layout.
    readonly filtering: Readonly<Ref<boolean>>;
    readonly first: Readonly<Ref<boolean>>;
    readonly waiting: Readonly<Ref<boolean>>;
    readonly dragging: Readonly<Ref<boolean>>;
}

// One mounted board's lane grid at its measured width, and the Finished fold that keeps the reader where the lane starts.
export const useBoardGrid = ({ board, view, move, content, saysEmpty, filtering, first, waiting, dragging }: BoardGridHost) => {
    const narrow = useNarrow(board, NARROW_BOARD_REM);
    const underThree = useNarrow(board, PAIRED_BOARD_REM);
    const underRoomy = useNarrow(board, ROOMY_BOARD_REM);
    const quiet = computed<QuietLanes>(() => ({
        attention: content(`attention`) !== `rows`,
        active: content(`active`) !== `rows`,
        finished: content(`finished`) !== `rows`,
    }));
    // The emptiness the layout is read from: the live one, or the last one seen before a query started.
    const judged = ref<QuietLanes>(LOUD);
    watch(
        [quiet, filtering, first, waiting],
        () => {
            if (first.value || waiting.value) {
                judged.value = LOUD;
            } else if (!filtering.value) {
                judged.value = quiet.value;
            }
        },
        { immediate: true },
    );
    const layout = computed(() => boardLayout(narrow.value, underThree.value, judged.value, !underRoomy.value));
    const kind = computed(() => layout.value.kind);
    // The paired grid starts at the board's height rather than being held to it (PLACE), and so do the layouts built on it.
    const placed = computed(() => kind.value !== `stacked` && kind.value !== `three`);
    const laneGrid = computed(() => GRID[kind.value]);
    // A lane's cell, in the layouts that place lanes by hand.
    const placeOf = (lane: FleetLane): string => {
        const { kind: at, wide } = layout.value;
        if (at === `ledger` && wide !== undefined) {
            return LEDGER_PLACE[wide][lane];
        }
        return at === `paired` || at === `tucked` ? PLACE[at][lane] : ``;
    };
    // The ledger's wide lane spans the board, so its cards take two columns of it rather than one line each.
    const spans = (lane: FleetLane): boolean => layout.value.kind === `ledger` && layout.value.wide === lane;
    // The lane holding the board's bottom-right corner, at whose foot the host's corner slot stands (AgentsView.vue): the
    // ledger's spanning lane, else Finished, which closes the reading order in every other shape.
    const corner = computed((): FleetLane => cornerLane(layout.value));
    // An empty lane in a layout that gave its column away says so on its header's line, not on a line of its own; while a
    // card is in hand it keeps the full line, so the lane stays a target worth aiming at.
    const sayInHeader = (lane: FleetLane): boolean => placed.value && !dragging.value && !first.value && saysEmpty(lane);
    // Folding Finished shrinks the board under the reader, and from its tail that drops them far below the lane; its header
    // is brought back to the top instead, so the fold lands where the lane starts.
    const toggleFinished = async (): Promise<void> => {
        const folding = view.value.all;
        move({ kind: `expand` });
        if (!folding) {
            return;
        }
        await nextTick();
        const lane = board.value?.querySelector<HTMLElement>(`[data-lane="finished"]`);
        const scroller = lane?.closest<HTMLElement>(`.overflow-auto`);
        if (lane && scroller && lane.getBoundingClientRect().top < scroller.getBoundingClientRect().top) {
            lane.scrollIntoView({ block: `start` });
        }
    };
    return { narrow, placed, laneGrid, placeOf, spans, corner, sayInHeader, toggleFinished };
};
