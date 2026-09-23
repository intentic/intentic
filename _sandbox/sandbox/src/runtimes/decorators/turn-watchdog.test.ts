import { test, expect, jest, afterEach } from "bun:test";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { beforeDeadline, DEFAULT_TURN_TIMEOUTS, EXPIRED, idleWait, SETTLED, turnWatchdog, watchedPull } from "./turn-watchdog.js";

// The clock's arithmetic at its edges, with the system time held still, and the waits it drives under fake timers.

const START = 1_700_000_000_000;

afterEach(() => {
    jest.useRealTimers();
    jest.setSystemTime();
});

test("a turn gets two minutes of silence and half an hour in all", () => {
    expect(DEFAULT_TURN_TIMEOUTS).toEqual({ inactivityMs: 120_000, maxTurnMs: 1_800_000 });
});

test("silence runs out at the inactivity window, and activity restarts the window", () => {
    jest.setSystemTime(START);
    const clock = turnWatchdog({ inactivityMs: 100, maxTurnMs: 1_000 });
    expect(clock.remaining()).toBe(100);

    jest.setSystemTime(START + 60);
    expect(clock.remaining()).toBe(40);
    clock.touch();
    expect(clock.remaining()).toBe(100);

    jest.setSystemTime(START + 160);
    expect(clock.remaining()).toBe(0);
});

test("the hard cap wins over activity: a turn that keeps talking still ends", () => {
    jest.setSystemTime(START);
    const clock = turnWatchdog({ inactivityMs: 100, maxTurnMs: 150 });

    jest.setSystemTime(START + 120);
    clock.touch();
    expect(clock.remaining()).toBe(30);
});

test("an announced wait moves silence past it, and never pulls the deadline in", () => {
    jest.setSystemTime(START);
    const clock = turnWatchdog({ inactivityMs: 100, maxTurnMs: 10_000 });

    clock.extendPast(START + 500);
    expect(clock.remaining()).toBe(600);

    clock.extendPast(START - 50);
    expect(clock.remaining()).toBe(600);
});

test("a caller's own deadline caps the wait when it comes first, and only then", () => {
    jest.setSystemTime(START);
    const clock = turnWatchdog({ inactivityMs: 100, maxTurnMs: 10_000 });

    expect(clock.remaining(START + 30)).toBe(30);
    expect(clock.remaining(START + 5_000)).toBe(100);
});

test("an idle wait ends on a wake, and on its own time when nobody wakes it", async () => {
    jest.useFakeTimers();
    const wait = idleWait();

    let woke = false;
    const parked = wait.park(1_000).then(() => {
        woke = true;
    });
    wait.wake();
    await parked;
    expect(woke).toBe(true);

    let timedOut = false;
    const unwoken = wait.park(50).then(() => {
        timedOut = true;
    });
    await advanceTimersByTimeAsync(49);
    expect(timedOut).toBe(false);
    await advanceTimersByTimeAsync(1);
    await unwoken;
    expect(timedOut).toBe(true);
});

test("a wake with nothing parked is dropped rather than ending the next wait early", async () => {
    jest.useFakeTimers();
    const wait = idleWait();
    wait.wake();

    let ended = false;
    const parked = wait.park(50).then(() => {
        ended = true;
    });
    await advanceTimersByTimeAsync(10);
    expect(ended).toBe(false);
    await advanceTimersByTimeAsync(40);
    await parked;
    expect(ended).toBe(true);
});

test("a pull drains what is queued before it reports the source settled, each item restarting the silence", async () => {
    jest.setSystemTime(START);
    const queue = ["a", "b"];
    const clock = turnWatchdog({ inactivityMs: 100, maxTurnMs: 10_000 });
    const pull = watchedPull({ take: () => queue.shift(), settled: () => true, clock, wait: idleWait() });

    jest.setSystemTime(START + 90);
    expect(await pull()).toBe("a");
    expect(clock.remaining()).toBe(100);
    expect(await pull()).toBe("b");
    expect(await pull()).toBe(SETTLED);
});

test("a pull parks until a producer wakes it with something to take", async () => {
    jest.useFakeTimers();
    const queue: string[] = [];
    const wait = idleWait();
    const pull = watchedPull({
        take: () => queue.shift(),
        settled: () => false,
        clock: turnWatchdog({ inactivityMs: 1_000, maxTurnMs: 10_000 }),
        wait,
    });

    const pulled = pull();
    await advanceTimersByTimeAsync(10);
    queue.push("late");
    wait.wake();
    expect(await pulled).toBe("late");
});

test("a pull with nothing arriving expires at the inactivity window, not before", async () => {
    jest.useFakeTimers();
    const pull = watchedPull({
        take: (): string | undefined => undefined,
        settled: () => false,
        clock: turnWatchdog({ inactivityMs: 100, maxTurnMs: 10_000 }),
        wait: idleWait(),
    });

    let answer: unknown = "pending";
    const pulled = pull().then((value) => {
        answer = value;
    });
    await advanceTimersByTimeAsync(99);
    expect(answer).toBe("pending");
    await advanceTimersByTimeAsync(1);
    await pulled;
    expect(answer).toBe(EXPIRED);
});

test("a pull's own deadline expires it ahead of the turn's, at that instant", async () => {
    jest.useFakeTimers();
    const graceEnds = Date.now() + 20;
    const pull = watchedPull({
        take: (): string | undefined => undefined,
        settled: () => false,
        clock: turnWatchdog({ inactivityMs: 1_000, maxTurnMs: 10_000 }),
        wait: idleWait(),
        until: () => graceEnds,
    });

    let answer: unknown = "pending";
    const pulled = pull().then((value) => {
        answer = value;
    });
    await advanceTimersByTimeAsync(19);
    expect(answer).toBe("pending");
    await advanceTimersByTimeAsync(1);
    await pulled;
    expect(answer).toBe(EXPIRED);
});

// Pi re-reads its abort grace on every pass, so the grace only shortens each park; expiry still waits for the window.
test("a deadline recomputed on every pass narrows each park without expiring the pull", async () => {
    jest.useFakeTimers();
    const pull = watchedPull({
        take: (): string | undefined => undefined,
        settled: () => false,
        clock: turnWatchdog({ inactivityMs: 100, maxTurnMs: 10_000 }),
        wait: idleWait(),
        until: () => Date.now() + 20,
    });

    let answer: unknown = "pending";
    const pulled = pull().then((value) => {
        answer = value;
    });
    await advanceTimersByTimeAsync(99);
    expect(answer).toBe("pending");
    await advanceTimersByTimeAsync(1);
    await pulled;
    expect(answer).toBe(EXPIRED);
});

test("a stream read that lands in time is its own answer; one that doesn't is EXPIRED", async () => {
    jest.useFakeTimers();
    const clock = turnWatchdog({ inactivityMs: 50, maxTurnMs: 10_000 });

    expect(await beforeDeadline(Promise.resolve("event"), clock)).toBe("event");

    const never = new Promise<string>(() => {});
    const raced = beforeDeadline(never, clock);
    await advanceTimersByTimeAsync(50);
    expect(await raced).toBe(EXPIRED);
});
