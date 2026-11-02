import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { type DueAt, nudgedPass } from "./nudged-pass.js";

// A pass that records when it ran and can be held open, for the nudges and timers around it.
const counted = (report?: (due: DueAt) => void) => {
    const runs: number[] = [];
    let release: (() => void) | undefined;
    let hold = false;
    const pass = async (now: number, due: DueAt): Promise<void> => {
        runs.push(now);
        report?.(due);
        if (hold) {
            await new Promise<void>((resolve) => {
                release = resolve;
            });
        }
    };
    return {
        runs,
        pass,
        holdNext: () => {
            hold = true;
        },
        release: () => {
            hold = false;
            release?.();
        },
    };
};

const failed = (error: Error): never => {
    throw error;
};

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test("a nudge runs one pass soon, however many came before it ran", async () => {
    const counter = counted();
    const passes = nudgedPass(counter.pass, { backstopMs: 60_000, settleMs: 10, failed });
    passes.start();
    try {
        passes.nudge();
        passes.nudge();
        passes.nudge();
        await advanceTimersByTimeAsync(9);
        expect(counter.runs).toEqual([]);
        await advanceTimersByTimeAsync(1);
        expect(counter.runs).toHaveLength(1);
        await advanceTimersByTimeAsync(50);
        expect(counter.runs).toHaveLength(1);
    } finally {
        passes.stop();
    }
});

// The pass may have read the state before the event that nudged it, so the event gets a pass of its own after it.
test("a nudge heard while a pass runs runs once more after it", async () => {
    const counter = counted();
    const passes = nudgedPass(counter.pass, { backstopMs: 60_000, settleMs: 10, failed });
    passes.start();
    try {
        counter.holdNext();
        const first = passes.run();
        passes.nudge();
        passes.nudge();
        counter.release();
        await first;
        expect(counter.runs).toHaveLength(1);
        await advanceTimersByTimeAsync(10);
        expect(counter.runs).toHaveLength(2);
        await advanceTimersByTimeAsync(50);
        expect(counter.runs).toHaveLength(2);
    } finally {
        passes.stop();
    }
});

test("a pass runs again at the soonest instant the last one reported, not at the backstop", async () => {
    let reported = false;
    const counter = counted((due) => {
        if (!reported) {
            reported = true;
            due(Date.now() + 400);
            due(Date.now() + 150);
        }
    });
    const passes = nudgedPass(counter.pass, { backstopMs: 60_000, failed });
    passes.start();
    try {
        const before = Date.now();
        await passes.run();
        await advanceTimersByTimeAsync(149);
        expect(counter.runs).toEqual([before]);
        await advanceTimersByTimeAsync(1);
        expect(counter.runs).toEqual([before, before + 150]);
        await advanceTimersByTimeAsync(250);
        expect(counter.runs).toHaveLength(2);
    } finally {
        passes.stop();
    }
});

// An instant that stays in the past (a hold the pass judged due but did not fire) must not spin the pass.
test("an instant already past waits the floor, and a stopped pass arms nothing", async () => {
    const counter = counted((due) => due(0));
    const passes = nudgedPass(counter.pass, { backstopMs: 60_000, floorMs: 200, failed });
    passes.start();
    await passes.run();
    await advanceTimersByTimeAsync(199);
    expect(counter.runs).toHaveLength(1);
    await advanceTimersByTimeAsync(1);
    expect(counter.runs).toHaveLength(2);
    passes.stop();
    const stopped = counter.runs.length;
    await advanceTimersByTimeAsync(300);
    expect(counter.runs).toHaveLength(stopped);
});

// A slow pass can outlast the instant it reported: no pass has seen that one due yet, so the next comes at once rather
// than a floor later (the scheduler's one-time wake fired a second late under CI load, 2026-10-21).
test("an instant that falls due while its pass still runs is run soon after, not a floor later", async () => {
    const reported: number[] = [];
    const counter = counted((due) => {
        reported.push(Date.now() + 30);
        due(reported.at(-1) ?? 0);
    });
    const passes = nudgedPass(counter.pass, { backstopMs: 60_000, settleMs: 10, floorMs: 5_000, failed });
    passes.start();
    try {
        counter.holdNext();
        const first = passes.run();
        await advanceTimersByTimeAsync(80);
        counter.release();
        await first;
        await advanceTimersByTimeAsync(9);
        expect(counter.runs).toHaveLength(1);
        await advanceTimersByTimeAsync(1);
        expect(counter.runs).toHaveLength(2);
        expect(counter.runs[1]).toBeGreaterThanOrEqual(reported[0] ?? Number.POSITIVE_INFINITY);
    } finally {
        passes.stop();
    }
});

test("a pass not started runs only when asked, with the clock it is given", async () => {
    const counter = counted((due) => due(Date.now() + 10));
    const passes = nudgedPass(counter.pass, { backstopMs: 20, failed });
    await passes.run(1_234);
    await advanceTimersByTimeAsync(80);
    expect(counter.runs).toEqual([1_234]);
});

test("a pass not started hears no nudge", async () => {
    const counter = counted();
    const passes = nudgedPass(counter.pass, { backstopMs: 60_000, settleMs: 5, failed });
    passes.nudge();
    await advanceTimersByTimeAsync(50);
    expect(counter.runs).toEqual([]);
});
