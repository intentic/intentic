import { advanceIdle, type IdleSample, LOCAL_MODEL_BUSY_TICKS_PER_MINUTE } from "./local-model-idle.js";

/* When a loaded model has stopped earning the memory it holds, decided from CPU samples alone. */

const NOW = 1_780_000_000_000;
const MINUTE = 60_000;
const IDLE = 30 * MINUTE;

// The previous sweep ran a minute ago unless a test says otherwise.
const seen = (cpuTicks: number, busyAt: number, sampledAt = NOW - MINUTE): IdleSample => ({ cpuTicks, busyAt, sampledAt });

test("a server seen for the first time is never idle, whatever its CPU total says", () => {
    // A daemon restart has no history; unloading on the first pass would undo a model someone is mid-turn with.
    const { next, idle } = advanceIdle(new Map(), new Map([["qwen", 9_999_999]]), NOW, IDLE);
    expect(idle).toEqual([]);
    expect(next.get("qwen")).toEqual(seen(9_999_999, NOW, NOW));
});

test("CPU that moved like a request resets the clock, and the total is carried forward", () => {
    const previous = new Map([["qwen", seen(1_000, NOW - 29 * MINUTE)]]);
    const { next, idle } = advanceIdle(previous, new Map([["qwen", 1_000 + LOCAL_MODEL_BUSY_TICKS_PER_MINUTE]]), NOW, IDLE);
    expect(idle).toEqual([]);
    expect(next.get("qwen")).toEqual(seen(1_000 + LOCAL_MODEL_BUSY_TICKS_PER_MINUTE, NOW, NOW));
});

test("CPU that did not move keeps the original clock, so idleness accumulates across samples", () => {
    const previous = new Map([["qwen", seen(1_000, NOW - 29 * MINUTE)]]);
    const { next } = advanceIdle(previous, new Map([["qwen", 1_000]]), NOW, IDLE);
    // Not NOW: the clock is when it last did work, which is what the window is measured from.
    expect(next.get("qwen")).toEqual(seen(1_000, NOW - 29 * MINUTE, NOW));
});

test("an idle server's own housekeeping ticks are not work, so it still unloads", () => {
    // What a quiet llama-server does by itself: a few ticks every minute, forever. Before the floor, this reset the
    // clock on every sweep and the model never unloaded.
    let samples: ReadonlyMap<string, IdleSample> = new Map([["qwen", seen(1_000, NOW - IDLE, NOW - IDLE)]]);
    let unloaded: readonly string[] = [];
    for (let minute = 1; minute <= 30; minute++) {
        const at = NOW - IDLE + minute * MINUTE;
        const decision = advanceIdle(samples, new Map([["qwen", 1_000 + 4 * minute]]), at, IDLE);
        samples = decision.next;
        unloaded = decision.idle;
    }
    expect(unloaded).toEqual(["qwen"]);
});

test("the busy rate is per minute, so a late sweep does not turn a trickle into a request", () => {
    // Five minutes between samples at four ticks a minute is twenty ticks: still housekeeping.
    const previous = new Map([["qwen", seen(1_000, NOW - 29 * MINUTE, NOW - 5 * MINUTE)]]);
    expect(advanceIdle(previous, new Map([["qwen", 1_020]]), NOW, IDLE).next.get("qwen")?.busyAt).toBe(NOW - 29 * MINUTE);
});

test("a CPU total that went backwards is a new process, which starts its clock again", () => {
    const previous = new Map([["qwen", seen(50_000, NOW - IDLE)]]);
    const { next, idle } = advanceIdle(previous, new Map([["qwen", 10]]), NOW, IDLE);
    expect(idle).toEqual([]);
    expect(next.get("qwen")?.busyAt).toBe(NOW);
});

test("a server past the window is idle, one a minute short of it is not", () => {
    const observed = new Map([
        ["over", 1_000],
        ["under", 2_000],
    ]);
    const previous = new Map([
        ["over", seen(1_000, NOW - IDLE)],
        ["under", seen(2_000, NOW - IDLE + MINUTE)],
    ]);
    expect(advanceIdle(previous, observed, NOW, IDLE).idle).toEqual(["over"]);
});

test("a server that stopped drops its sample, so coming back starts its clock again", () => {
    const previous = new Map([["qwen", seen(1_000, NOW - 10 * IDLE)]]);
    // Not running this pass: absent from `observed`.
    const gone = advanceIdle(previous, new Map(), NOW, IDLE);
    expect(gone.next.has("qwen")).toBe(false);
    expect(gone.idle).toEqual([]);
    // Back with the same CPU total it had before, and it is not instantly idle again.
    const back = advanceIdle(gone.next, new Map([["qwen", 1_000]]), NOW + MINUTE, IDLE);
    expect(back.idle).toEqual([]);
});

test("a window of zero switches unloading off rather than unloading everything", () => {
    const previous = new Map([["qwen", seen(1_000, NOW - 10 * IDLE)]]);
    expect(advanceIdle(previous, new Map([["qwen", 1_000]]), NOW, 0).idle).toEqual([]);
});
