import { expect, test } from "vitest";
import { registerTurn, SteeringQueue, steerTurn, stopTurn } from "./agent-steering.js";

const drain = async (queue: SteeringQueue): Promise<string[]> => {
    const out: string[] = [];
    for await (const text of queue) {
        out.push(text);
    }
    return out;
};

test("pushed messages are yielded in order and close() ends iteration", async () => {
    const queue = new SteeringQueue();
    queue.push("first");
    const drained = drain(queue);
    queue.push("second");
    queue.close();
    expect(await drained).toEqual(["first", "second"]);
});

test("push after close reports undelivered", () => {
    const queue = new SteeringQueue();
    queue.close();
    expect(queue.push("late")).toBe(false);
});

test("a consumer parked on an empty queue wakes on push", async () => {
    const queue = new SteeringQueue();
    const drained = drain(queue);
    // The consumer is awaiting before anything is pushed — the wake path, not the buffered path.
    await new Promise((resolve) => setImmediate(resolve));
    queue.push("woken");
    queue.close();
    expect(await drained).toEqual(["woken"]);
});

test("steer and stop reach the registered turn; unknown conversations report false", () => {
    const queue = new SteeringQueue();
    let aborted = false;
    const unregister = registerTurn("conv-1", { abort: () => (aborted = true), steering: queue });
    expect(steerTurn("conv-1", "go left")).toBe(true);
    expect(steerTurn("conv-2", "nobody home")).toBe(false);
    expect(stopTurn("conv-1")).toBe(true);
    expect(aborted).toBe(true);
    unregister();
    expect(steerTurn("conv-1", "gone")).toBe(false);
    expect(stopTurn("conv-1")).toBe(false);
});

test("a turn without a steering queue can be stopped but not steered", () => {
    let aborted = false;
    const unregister = registerTurn("conv-native", { abort: () => (aborted = true) });
    expect(steerTurn("conv-native", "text")).toBe(false);
    expect(stopTurn("conv-native")).toBe(true);
    expect(aborted).toBe(true);
    unregister();
});

test("a stale entry's unregister cannot clobber its successor's registration", () => {
    const first = registerTurn("conv-x", { abort: () => {} });
    const successorQueue = new SteeringQueue();
    registerTurn("conv-x", { abort: () => {}, steering: successorQueue });
    first();
    expect(steerTurn("conv-x", "still here")).toBe(true);
});
