import { test, expect } from "bun:test";
import { registerTurn, SteeringQueue, steeringRelay, steerTurn, stopTurn, turnActive, turnSteered } from "./agent-steering.js";

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
    expect(queue.delivered).toBe(2);
});

test("push after close reports undelivered and does not count as delivered", () => {
    const queue = new SteeringQueue();
    queue.close();
    expect(queue.push("late")).toBe(false);
    expect(queue.delivered).toBe(0);
});

test("a consumer parked on an empty queue wakes on push", async () => {
    const queue = new SteeringQueue();
    const drained = drain(queue);
    // The consumer is awaiting before anything is pushed: the wake path, not the buffered path.
    await new Promise((resolve) => setImmediate(resolve));
    queue.push("woken");
    queue.close();
    expect(await drained).toEqual(["woken"]);
});

// The relay exists for one shape: a plan turn is two runs with an approval pause between them, and both borrow the
// conversation's single queue. Shared by the Codex and Cursor adapters, which both run that shape.

test("each phase borrows the queue in turn, and a closed phase yields nothing more", async () => {
    const queue = new SteeringQueue();
    const lend = steeringRelay(queue);
    const first = lend();
    queue.push("during planning");
    const planning: string[] = [];
    const reading = (async () => {
        for await (const text of first.steering) {
            planning.push(text);
        }
    })();
    await new Promise((resolve) => setImmediate(resolve));
    first.close();
    await reading;
    expect(planning).toEqual(["during planning"]);
});

test("a message typed during the pause waits for the next phase rather than reaching the closed one", async () => {
    const queue = new SteeringQueue();
    const lend = steeringRelay(queue);
    const first = lend();
    const planning: string[] = [];
    const reading = (async () => {
        for await (const text of first.steering) {
            planning.push(text);
        }
    })();
    await new Promise((resolve) => setImmediate(resolve));
    first.close();
    await reading;
    // Typed while the plan card is on screen: no phase is reading, so the relay holds it.
    queue.push("actually, skip the tests");
    await new Promise((resolve) => setImmediate(resolve));
    expect(planning).toEqual([]);

    const second = lend();
    const executing: string[] = [];
    const draining = (async () => {
        for await (const text of second.steering) {
            executing.push(text);
        }
    })();
    queue.close();
    await draining;
    expect(executing).toEqual(["actually, skip the tests"]);
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
    expect(turnActive("conv-native")).toBe(true);
    expect(steerTurn("conv-native", "text")).toBe(false);
    expect(stopTurn("conv-native")).toBe(true);
    expect(aborted).toBe(true);
    unregister();
    expect(turnActive("conv-native")).toBe(false);
});

test("a stale entry's unregister cannot clobber its successor's registration", () => {
    const first = registerTurn("conv-x", { abort: () => {} });
    const successorQueue = new SteeringQueue();
    registerTurn("conv-x", { abort: () => {}, steering: successorQueue });
    first();
    expect(steerTurn("conv-x", "still here")).toBe(true);
});

// Attendance, which is the one fact about a turn that can arrive after it starts

test("a delivered steer marks the turn as watched, and a new turn starts unwatched again", () => {
    const queue = new SteeringQueue();
    const unregister = registerTurn("c1", { abort: () => {}, steering: queue });
    expect(turnSteered("c1")).toBe(false);
    expect(steerTurn("c1", "actually, do it this way")).toBe(true);
    expect(turnSteered("c1")).toBe(true);
    // The next turn in the same conversation is its own turn: a wake hours later must not inherit an audience that
    // typed once and left.
    unregister();
    registerTurn("c1", { abort: () => {}, steering: new SteeringQueue() });
    expect(turnSteered("c1")).toBe(false);
});

test("a steer nobody could deliver leaves the turn unwatched", () => {
    const queue = new SteeringQueue();
    registerTurn("c2", { abort: () => {}, steering: queue });
    queue.close();
    expect(steerTurn("c2", "too late")).toBe(false);
    expect(turnSteered("c2")).toBe(false);
    // And a conversation with no turn at all was never watched.
    expect(turnSteered("c3")).toBe(false);
});
