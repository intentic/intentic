import type { WorkflowRun } from "@intentic/sandbox-contract/schemas/workflows";
import { doneWith, type FleetAgent } from "../../../models/fleet/useAgents-fleet";
import type { OpenChat } from "./cardView";

// THE FINISHED LANE SHOWS WHAT IS STILL OWED AND FOLDS WHAT IS DONE WITH. The rail is a working set: what runs, what
// waits on the reader, a draft, news not read yet, work not landed. A finished chat that owes none of that (doneWith,
// the same verdict the twelve-hour tidy closes on) has nothing left to show, so it goes under the lane's "N done" fold
// rather than standing among the ones that do. Folded, not closed: it is still an open tab (Ctrl+Tab reaches it, the
// fold opens it in place), and the tidy still closes it on its own clock. Replaced (2026-10-28) the lane's count cap
// ("7 shown, 12 earlier"), which hid by age: a read chat from a minute ago stood where an unread one from an hour ago
// was cut.
//
// What keeps a done chat out of the fold anyway:
// - it is on screen here (focused, or holding a column): it folds once the reader moves on, never under them
// - words typed in it in this window, which the roster hears a beat later (useAgents-fleet's unsent report)
// - the reader's pointer over the list: each chat keeps the side it was drawn on until it leaves, so a press never lands
//   on a card that moved (the lanes' own steadyLanes rule)

export const chatDoneWith = (entry: OpenChat, onScreen: (id: string) => boolean, done: (agent: FleetAgent) => boolean = doneWith): boolean =>
    entry.agent !== undefined && !entry.conversation.unsent.value && !onScreen(entry.conversation.conversationId) && done(entry.agent);

// A finished run folds when every step it ran is done with (a step waives unread there, read through its run's row) and
// its diagram is not what is on screen. A step the roster no longer lists (archived, or never filed) counts as done; a
// run none of whose steps the roster lists folds too, since there is nothing of it left to act on.
export const runDoneWith = (
    run: WorkflowRun,
    fleet: readonly FleetAgent[],
    onScreen: boolean,
    done: (agent: FleetAgent) => boolean = doneWith,
): boolean => !onScreen && fleet.filter((agent) => agent.workflow?.runId === run.runId).every(done);

export interface FinishedFold<T> {
    // Drawn above the fold, in the lane's own order.
    readonly shown: T[];
    // Under it, in the same order.
    readonly folded: T[];
}

/**
 * Splits a Finished lane into what is drawn and what is folded, keeping each side in the lane's order. `held` is the
 * split last drawn, while the reader's pointer is over the list: a chat keeps the side it was drawn on, done or not, so
 * one pressed under an open fold stays where it was pressed rather than jumping above it.
 */
export const foldFinished = <T>(
    finished: readonly T[],
    isDone: (entry: T) => boolean,
    idOf: (entry: T) => string,
    held: FinishedFold<string> | undefined,
): FinishedFold<T> => {
    const shown: T[] = [];
    const folded: T[] = [];
    const heldShown = new Set(held?.shown);
    const heldFolded = new Set(held?.folded);
    for (const entry of finished) {
        const id = idOf(entry);
        const fold = heldShown.has(id) ? false : heldFolded.has(id) || isDone(entry);
        (fold ? folded : shown).push(entry);
    }
    return { shown, folded };
};
