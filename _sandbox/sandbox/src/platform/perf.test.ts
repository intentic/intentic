import { type Logger, pino } from "pino";
import { expect, test, vi } from "vitest";
import { createPerfTracker } from "./perf.js";

// A logger that keeps its lines instead of writing them, so a test can assert WHICH sink a line landed in.
// pino's own destination-as-object hook: `write` gets the serialized line, which is what a file would receive.
// Annotated `Logger` for the same reason createLogger is: pino's return widens its custom-levels generic, and
// under exactOptionalPropertyTypes the widened type is not the one the tracker takes.
const capturing = (): { logger: Logger; lines: Record<string, unknown>[] } => {
    const lines: Record<string, unknown>[] = [];
    const logger: Logger = pino({ level: "debug", messageKey: "message" }, { write: (line: string) => lines.push(JSON.parse(line)) });
    return { logger, lines };
};

test("a slow span goes to the perf sink and never to the main log", () => {
    const main = capturing();
    const perf = capturing();
    const tracker = createPerfTracker(main.logger, perf.logger);

    // git.run's floor is 200ms; 500 is comfortably past it.
    tracker.record("git.run", 500, { repo: "intentic" });
    tracker.stop();

    expect(perf.lines).toHaveLength(1);
    expect(perf.lines[0]).toMatchObject({ level: 40, perf: "git.run", ms: 500, repo: "intentic", message: "slow git.run" });
    // The whole point of the split: daemon.log stays clean, so the errors in it can be found.
    expect(main.lines).toEqual([]);
});

test("a slow span carries the machine's load, so slow-because-busy is separable from slow-because-broken", () => {
    const perf = capturing();
    const tracker = createPerfTracker(capturing().logger, perf.logger);

    tracker.record("git.run", 500, {});
    tracker.stop();

    // The value depends on the host, only its presence and type are ours to assert.
    expect(typeof perf.lines[0]?.["load1"]).toBe("number");
});

test("a slow span says whether this is the first time or the four-hundredth", () => {
    const perf = capturing();
    const tracker = createPerfTracker(capturing().logger, perf.logger);

    tracker.record("git.run", 500, {});
    tracker.record("git.run", 10, {});
    tracker.record("git.run", 500, {});
    tracker.stop();

    // Two slow lines out of three spans: `seen` counts every span, `slowSeen` only the slow ones, which is what
    // decides whether to look at this instance or at the pattern.
    expect(perf.lines.map((line) => [line["seen"], line["slowSeen"]])).toEqual([
        [1, 1],
        [3, 2],
    ]);
});

test("a span under its floor never reaches the perf sink, and traces to the main log at debug", () => {
    const main = capturing();
    const perf = capturing();
    const tracker = createPerfTracker(main.logger, perf.logger);

    // Well under git.run's 200ms floor.
    tracker.record("git.run", 5, { repo: "intentic" });
    tracker.stop();

    expect(perf.lines).toEqual([]);
    // The trace stays on the main logger: raising logLevel is meant to turn this instrumentation into a full
    // trace in the log a developer is already reading.
    expect(main.lines).toMatchObject([{ level: 20, perf: "git.run", ms: 5 }]);
});

test("with no perf sink the slow lines fall back to the main log rather than being lost", () => {
    const main = capturing();
    const tracker = createPerfTracker(main.logger);

    tracker.record("git.run", 500, {});
    tracker.stop();

    // A dev run with no writable history root: crowding one console beats dropping the measurement.
    expect(main.lines).toMatchObject([{ level: 40, perf: "git.run", message: "slow git.run" }]);
});

test("the ranked summary stays on the main log, where an incident reader is already looking", () => {
    vi.useFakeTimers();
    const main = capturing();
    const perf = capturing();
    const tracker = createPerfTracker(main.logger, perf.logger);

    tracker.record("git.run", 500, {});
    vi.advanceTimersByTime(60_000);
    tracker.stop();
    vi.useRealTimers();

    const summary = main.lines.find((line) => line["perfSummary"] !== undefined);
    expect(summary).toMatchObject({ level: 30 });
    expect(summary?.["perfSummary"]).toMatchObject([{ op: "git.run", count: 1, slow: 1 }]);
    // The summary is the main log's share of this instrumentation; the per-span lines are not.
    expect(perf.lines.every((line) => line["perfSummary"] === undefined)).toBe(true);
});

test("track records a failed span and rethrows the error untouched", async () => {
    const perf = capturing();
    const tracker = createPerfTracker(capturing().logger, perf.logger);
    const boom = new Error("git died");

    await expect(
        tracker.track("git.run", { repo: "intentic" }, () => {
            throw boom;
        }),
    ).rejects.toBe(boom);

    expect(tracker.ranked()).toMatchObject([{ op: "git.run", count: 1, failed: 1 }]);
    tracker.stop();
});
