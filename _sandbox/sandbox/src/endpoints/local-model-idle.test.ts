import { test, expect } from "bun:test";
import { advanceIdle, type IdleSample } from "./local-model-idle.js";

/* When a loaded model has stopped earning the memory it holds, decided from CPU samples alone. */

const NOW = 1_780_000_000_000;
const MINUTE = 60_000;
const IDLE = 30 * MINUTE;

const seen = (cpuTicks: number, busyAt: number): IdleSample => ({ cpuTicks, busyAt });

test("a server seen for the first time is never idle, whatever its CPU total says", () => {
    // A daemon restart has no history; unloading on the first pass would undo a model someone is mid-turn with.
    const { next, idle } = advanceIdle(new Map(), new Map([["qwen", 9_999_999]]), NOW, IDLE);
    expect(idle).toEqual([]);
    expect(next.get("qwen")).toEqual(seen(9_999_999, NOW));
});

test("CPU that moved resets the clock, and the total is carried forward", () => {
    const previous = new Map([["qwen", seen(1_000, NOW - 29 * MINUTE)]]);
    const { next, idle } = advanceIdle(previous, new Map([["qwen", 1_050]]), NOW, IDLE);
    expect(idle).toEqual([]);
    expect(next.get("qwen")).toEqual(seen(1_050, NOW));
});

test("CPU that did not move keeps the original clock, so idleness accumulates across samples", () => {
    const previous = new Map([["qwen", seen(1_000, NOW - 29 * MINUTE)]]);
    const { next } = advanceIdle(previous, new Map([["qwen", 1_000]]), NOW, IDLE);
    // Not NOW: the clock is when it last did work, which is what the window is measured from.
    expect(next.get("qwen")).toEqual(seen(1_000, NOW - 29 * MINUTE));
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
