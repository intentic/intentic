import { type Logger, pino } from "pino";
import { expect, test, vi } from "vitest";
import { createPerfTracker } from "./perf.js";

// Captures lines instead of writing them, so a test can assert which sink got a line. Explicit `Logger` type works
// around pino's widened return under exactOptionalPropertyTypes.
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
    expect(main.lines).toEqual([]);
});

test("a slow span carries the machine's load, so slow-because-busy is separable from slow-because-broken", () => {
    const perf = capturing();
    const tracker = createPerfTracker(capturing().logger, perf.logger);

    tracker.record("git.run", 500, {});
    tracker.stop();

    // Value depends on the host; only presence and type are ours to assert.
    expect(typeof perf.lines[0]?.["load1"]).toBe("number");
});

test("a slow span says whether this is the first time or the four-hundredth", () => {
    const perf = capturing();
    const tracker = createPerfTracker(capturing().logger, perf.logger);

    tracker.record("git.run", 500, {});
    tracker.record("git.run", 10, {});
    tracker.record("git.run", 500, {});
    tracker.stop();

    // `seen` counts every span, `slowSeen` only the slow ones.
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
    expect(main.lines).toMatchObject([{ level: 20, perf: "git.run", ms: 5 }]);
});

test("with no perf sink the slow lines fall back to the main log rather than being lost", () => {
    const main = capturing();
    const tracker = createPerfTracker(main.logger);

    tracker.record("git.run", 500, {});
    tracker.stop();

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
    expect(perf.lines.every((line) => line["perfSummary"] === undefined)).toBe(true);
});

test("a wait op is printed beside the work it explains, however far down the ranking it falls", () => {
    vi.useFakeTimers();
    const main = capturing();
    const tracker = createPerfTracker(main.logger, capturing().logger);

    // A wait's total is small by construction, so it can rank below the op it explains; git.lock.hold/git.lock.wait
    // test that pairing.
    tracker.record("git.lock.hold", 4_000, {});
    tracker.record("git.run", 3_000, {});
    // 20 fillers, each outranking both waits, so the top twelve fills without them.
    for (let index = 0; index < 20; index += 1) {
        tracker.record(`filler.${index}`, 100, {});
    }
    tracker.record("git.lock.wait", 1, {});
    tracker.record("git.run.wait", 1, {});
    vi.advanceTimersByTime(60_000);
    tracker.stop();
    vi.useRealTimers();

    const rows = main.lines.find((line) => line["perfSummary"] !== undefined)?.["perfSummary"] as { op: string }[];
    const ops = rows.map((row) => row.op);
    // Both pairing spellings: `X.hold` → `X.wait`; anything else → `<itself>.wait`.
    expect(ops).toContain("git.lock.wait");
    expect(ops).toContain("git.run.wait");
    // The waits appear because their work op made the cut, not on their own rank.
    expect(ops.slice(0, 12)).toEqual(["git.lock.hold", "git.run", ...Array.from({ length: 10 }, (_, index) => `filler.${index}`)]);
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
