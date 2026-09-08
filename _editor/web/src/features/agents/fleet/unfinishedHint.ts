import type { UnfinishedWork } from "@intentic/sandbox-contract";
import { relativeTime } from "../../chat/models/catalog";

// The sentence for work a session's last turn left open (AgentSummary.unfinished), read on the card's corner glyph
// and the detail header's status. Both halves are the turn's own measured facts (the registry's unfinishedOf), never a
// model's judgment, so this can only be out of date, not wrong.

// Noun agrees with the total, not the count left: '1 of 4 steps', but '1 of 1 step'.
const stepsLeft = (work: UnfinishedWork): string | undefined => {
    const open = work.steps;
    if (open === undefined) {
        return undefined;
    }
    return `${open.open} of ${open.total} ${open.total === 1 ? `step` : `steps`} unfinished`;
};

// Everything the card's face doesn't already say; each half drops instead of faking one the turn had nothing to report.
// Two sentences, since they're separate evidence: the agent's own checklist, and a check that ran on the tree it left.
export const unfinishedHint = (work: UnfinishedWork, now?: number): string => {
    // Clause, age, then the thing itself, matching the unsent chip's hover shape.
    // A comma clause, not '2h ago', since relativeTime answers 'just now' inside the first minute.
    const age = relativeTime(work.at, now);
    const left = stepsLeft(work);
    const next = work.steps?.next;
    const said = left === undefined ? [] : [`Stopped with ${left}, ${age}${next === undefined ? `` : `: ${next}`}`];
    const check = work.check;
    if (check !== undefined) {
        // Age said once, not repeated: a second mention would read as a different moment, not the same ending.
        said.push(left === undefined ? `Its own check was still failing, ${age}: ${check}` : `Its own check was still failing too: ${check}`);
    }
    return said.join(`. `);
};
