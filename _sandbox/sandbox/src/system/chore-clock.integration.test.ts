import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Chore, choreDue, HOUR_MS, startChoreClock } from "./chore-clock.js";

// What makes a chore the right home for an hourly pass: when it last started is kept on the history volume, so a daemon
// that restarts more often than the chore falls due does not run it again at each boot.

const logger = { warn: () => {} };
const START = 1_700_000_000_000;

// A clock whose own timer never fires (a day between ticks), so every look is the test's own.
const clockAt = (historyRoot: string, chores: readonly Chore[], at: { now: number }) =>
    startChoreClock({ historyRoot, logger, now: () => at.now, tickMs: 24 * HOUR_MS, warmupMs: 24 * HOUR_MS }, chores);

const hourly = (name: string, ran: string[]): Chore => ({
    name,
    everyMs: HOUR_MS,
    run: async () => {
        ran.push(name);
    },
});

test("a chore never run is due, and one run less than its interval ago is not, by the minute at its edge", () => {
    expect(choreDue(undefined, HOUR_MS, START)).toBe(true);
    expect(choreDue(START, HOUR_MS, START + HOUR_MS - 1)).toBe(false);
    expect(choreDue(START, HOUR_MS, START + HOUR_MS)).toBe(true);
    // A clock stepped back reads as due rather than never.
    expect(choreDue(START, HOUR_MS, START - 1)).toBe(true);
});

test("a restart inside the hour does not run an hourly chore again, and one past it does", async () => {
    const historyRoot = mkdtempSync(join(tmpdir(), "chore-clock-"));
    const ran: string[] = [];
    const at = { now: START };
    const first = clockAt(historyRoot, [hourly("log-retention", ran)], at);
    await first.tick();
    first.stop();
    expect(ran).toEqual(["log-retention"]);

    // The daemon restarted ten minutes later: a new clock over the same volume.
    at.now = START + 10 * 60_000;
    const second = clockAt(historyRoot, [hourly("log-retention", ran)], at);
    await second.tick();
    expect(ran).toEqual(["log-retention"]);

    at.now = START + HOUR_MS;
    await second.tick();
    second.stop();
    expect(ran).toEqual(["log-retention", "log-retention"]);
});

test("a chore that throws waits out its interval like one that finished, and the others still run", async () => {
    const historyRoot = mkdtempSync(join(tmpdir(), "chore-clock-"));
    const ran: string[] = [];
    const failing: Chore = {
        name: "state-aged",
        everyMs: HOUR_MS,
        run: async () => {
            ran.push("state-aged");
            throw new Error("the disk was full");
        },
    };
    const at = { now: START };
    const clock = clockAt(historyRoot, [failing, hourly("log-retention", ran)], at);
    await clock.tick();
    at.now = START + 5 * 60_000;
    await clock.tick();
    clock.stop();
    expect(ran.toSorted()).toEqual(["log-retention", "state-aged"]);
});
