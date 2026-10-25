import type { AutomationRun } from "@intentic/sandbox-contract/schemas/automations";

// The run ledger as somebody reads it: a run that ended the same way for the same reason as the one before it is the
// same news, so consecutive repeats are one entry with a count. Twelve nights of "guard found nothing", or one error
// five times over, would otherwise push everything else out of view.

export interface RunEntry {
    readonly outcome: AutomationRun[`outcome`];
    readonly detail: string | undefined;
    // The newest run of the entry: when it was, and the conversation a press opens.
    readonly newest: AutomationRun;
    readonly oldestAt: number;
    readonly count: number;
}

// Newest first in, newest first out, as the ledger keeps them.
export const runEntries = (runs: readonly AutomationRun[]): RunEntry[] => {
    const entries: RunEntry[] = [];
    for (const run of runs) {
        const last = entries.at(-1);
        // A completed run's detail is its result ("3 advisories, 2 patched"), never a repeat worth folding.
        if (last !== undefined && run.outcome !== `completed` && last.outcome === run.outcome && last.detail === run.detail) {
            entries[entries.length - 1] = { ...last, oldestAt: run.at, count: last.count + 1 };
        } else {
            entries.push({ outcome: run.outcome, detail: run.detail, newest: run, oldestAt: run.at, count: 1 });
        }
    }
    return entries;
};

// How many of each, worst first: the order anyone scanning a history wants it said in. An outcome with none is left out.
const ORDER: readonly AutomationRun[`outcome`][] = [`error`, `interrupted`, `completed`, `skipped`];
export const runTally = (runs: readonly AutomationRun[]): { outcome: AutomationRun[`outcome`]; count: number }[] =>
    ORDER.map((outcome) => ({ outcome, count: runs.filter((run) => run.outcome === outcome).length })).filter((entry) => entry.count > 0);

// How many of the newest runs failed in a row, for the callout over a failing automation: one failure is a blip, five
// in a row is a job that has stopped working.
export const failureStreak = (runs: readonly AutomationRun[]): number => {
    const broken = runs.findIndex((run) => run.outcome !== `error`);
    return broken === -1 ? runs.length : broken;
};
