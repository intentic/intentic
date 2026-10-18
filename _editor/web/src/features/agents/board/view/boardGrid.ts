import { useNarrow } from "@intentic/ui";
import { computed, nextTick, type Ref } from "vue";
import type { FleetLane } from "../../../../models/agent-status/agentStatus-lanes";
import type { BoardView, ViewEvent } from "./boardView";

// The board's own width, measured (useNarrow): a container query's `container-type` would contain the fixed drag ghost.
// THREE SHAPES, NOT TWO. Under 48rem the lanes stack. From there to 72rem (a tablet, a small laptop, a desktop with the
// chat docked) three columns leave a card about 300px wide, and after its glyph, standing and presses its title kept
// some 60px of that ("Soft-delet…"); so the board is two columns there: the lanes about work in flight (Attention over
// Active, both short) share the first, and Finished, the long ledger, has the second. Reading order is the same in all
// three shapes: Attention, Active, Finished.
const NARROW_BOARD_REM = 48;
const PAIRED_BOARD_REM = 72;

// Where each lane sits in the paired shape: Finished spans both rows of the second column, so the first column's rows
// size to Attention and Active alone (`grid-rows-[auto_1fr]`: the second row takes whatever Finished needs past them).
// That needs the rows sized by what they hold: held to the board's height (`h-full`) with the lanes allowed to shrink
// (`min-h-0`), as three columns in one row can be, a long Attention lane left Active a 0px row and drew it over its cards;
// so the paired grid only starts at the board's height (`min-h-full`) and its lanes keep their own.
export const PAIRED_PLACE = {
    attention: `col-start-1 row-start-1`,
    active: `col-start-1 row-start-2`,
    finished: `col-start-2 row-span-2 row-start-1`,
} satisfies Record<FleetLane, string>;

export interface BoardGridHost {
    readonly board: Ref<HTMLElement | undefined>;
    readonly view: Readonly<Ref<BoardView>>;
    readonly move: (event: ViewEvent) => void;
}

// One mounted board's lane grid at its measured width, and the Finished fold that keeps the reader where the lane starts.
export const useBoardGrid = ({ board, view, move }: BoardGridHost) => {
    const narrow = useNarrow(board, NARROW_BOARD_REM);
    const underThree = useNarrow(board, PAIRED_BOARD_REM);
    const paired = computed(() => underThree.value && !narrow.value);
    const laneGrid = computed(() => (narrow.value ? `content-start` : paired.value ? `grid-cols-2 grid-rows-[auto_1fr] items-start lg:gap-6 lg:p-6` : `grid-cols-3 items-start lg:gap-6 lg:p-6`));
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
    return { narrow, paired, laneGrid, toggleFinished };
};
