import { t } from "@intentic/ui/i18n";
import { type ComputedRef, computed, inject } from "vue";
import type { FleetAgent } from "../../models/fleet/useAgents-fleet";
import { stackedRuns, trayCount } from "../../models/fleet/board/childFold";
import { CHILD_ROWS } from "../../models/fleet/board/childRows";

// THE FAMILY, COUNTED. A card's tray (ChildRows) opens only while the reader is looking at that card, so every other
// card says what hangs under it instead: how many agents it started, and while any are still at work, how many of the
// total. Reads the board's trays itself, as the tray does, so a child's tick redraws only what wears the count.
// Undefined where no board provides trays, or for a card that started nothing. On the card of an automation's latest
// run, whose tray holds only its earlier runs (childFold, stackedRuns), it counts those as runs, not as a family.
export interface ChildTally {
    readonly total: number;
    readonly running: number;
    /** Every rider an earlier run of the card's automation, and nothing its runtime ran in-process. */
    readonly runs: boolean;
    /** The count in words, for a hover or a label. */
    readonly hint: string;
}

export const useChildCount = (agent: () => FleetAgent): ComputedRef<ChildTally | undefined> => {
    const board = inject(CHILD_ROWS, undefined);
    return computed(() => {
        if (board === undefined) {
            return undefined;
        }
        const children = board.childrenOf(agent());
        const count = trayCount(children, board.subagentsOf(agent()));
        if (count === undefined) {
            return undefined;
        }
        const runs = stackedRuns(children).length === count.total;
        const hint = runs
            ? count.running > 0
                ? t(`agents.childRows.runsWorking`, { running: count.running, total: count.total })
                : t(`agents.childRows.runsCount`, { count: count.total })
            : count.running > 0
              ? t(`agents.childRows.workingCount`, { running: count.running, total: count.total })
              : t(`agents.childRows.startedCount`, { count: count.total });
        return { ...count, runs, hint };
    });
};
