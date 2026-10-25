import type { AutomationRun } from "@intentic/sandbox-contract/schemas/automations";
import { failureStreak, runEntries, runTally } from "./runHistory";

const run = (at: number, outcome: AutomationRun[`outcome`], detail?: string): AutomationRun => ({ at, outcome, detail, conversationId: `c${at}` });

test(`consecutive runs that ended the same way for the same reason are one entry, opening the newest`, () => {
    const entries = runEntries([
        run(5, `error`, `org disabled`),
        run(4, `error`, `org disabled`),
        run(3, `completed`),
        run(2, `error`, `exited 143`),
        run(1, `error`, `exited 143`),
    ]);
    expect(entries.map((entry) => [entry.outcome, entry.count, entry.newest.at, entry.oldestAt])).toEqual([
        [`error`, 2, 5, 4],
        [`completed`, 1, 3, 3],
        [`error`, 2, 2, 1],
    ]);
    expect(entries[0]?.newest.conversationId).toBe(`c5`);
});

test(`completed runs never fold, a different reason starts a new entry, and the same reason apart does not join`, () => {
    const entries = runEntries([run(4, `completed`, `done`), run(3, `completed`, `done`), run(2, `skipped`, `a`), run(1, `skipped`, `b`)]);
    expect(entries.map((entry) => entry.count)).toEqual([1, 1, 1, 1]);
});

test(`the tally is worst first and leaves out what never happened; the streak counts failures from the newest`, () => {
    const runs = [run(4, `error`), run(3, `error`), run(2, `skipped`), run(1, `error`)];
    expect(runTally(runs)).toEqual([
        { outcome: `error`, count: 3 },
        { outcome: `skipped`, count: 1 },
    ]);
    expect(failureStreak(runs)).toBe(2);
    expect(failureStreak([run(1, `error`)])).toBe(1);
    expect(failureStreak([])).toBe(0);
});
