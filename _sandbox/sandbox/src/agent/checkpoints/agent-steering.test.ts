import { test, expect } from "bun:test";
import { type AgentEvent, peerMessagePrompt, watchWakePrompt } from "@intentic/sandbox-contract";
import { clearTurnTaint, conversationTaintSource, createTurnTaint, publishTurnTaint } from "../../guard/turn-taint.js";
import { startTurnRun, turnRunOf } from "../run/turn/turn-runs.js";
import { registerTurn, type Steer, SteeringQueue, steeringRelay, steerTurn, stopTurn, turnActive, turnSteered } from "./agent-steering.js";

const person = (text: string): Steer => ({ text, voice: "person" });

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
    expect(steerTurn("conv-1", person("go left"))).toBe(true);
    expect(steerTurn("conv-2", person("nobody home"))).toBe(false);
    expect(stopTurn("conv-1")).toBe(true);
    expect(aborted).toBe(true);
    unregister();
    expect(steerTurn("conv-1", person("gone"))).toBe(false);
    expect(stopTurn("conv-1")).toBe(false);
});

test("a turn without a steering queue can be stopped but not steered", () => {
    let aborted = false;
    const unregister = registerTurn("conv-native", { abort: () => (aborted = true) });
    expect(turnActive("conv-native")).toBe(true);
    expect(steerTurn("conv-native", person("text"))).toBe(false);
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
    expect(steerTurn("conv-x", person("still here"))).toBe(true);
});

// Attendance, which is the one fact about a turn that can arrive after it starts

test("a delivered steer marks the turn as watched, and a new turn starts unwatched again", () => {
    const queue = new SteeringQueue();
    const unregister = registerTurn("c1", { abort: () => {}, steering: queue });
    expect(turnSteered("c1")).toBe(false);
    expect(steerTurn("c1", person("actually, do it this way"))).toBe(true);
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
    expect(steerTurn("c2", person("too late"))).toBe(false);
    expect(turnSteered("c2")).toBe(false);
    // And a conversation with no turn at all was never watched.
    expect(turnSteered("c3")).toBe(false);
});

const liveRun = (conversationId: string): { readonly release: () => void } => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    startTurnRun(
        async function* (): AsyncGenerator<AgentEvent> {
            await held;
            yield { kind: "done" };
        },
        { prompt: "start", conversationId },
    );
    return { release };
};

const WAKE = watchWakePrompt({
    outcome: "met",
    id: "watch-k3f9",
    note: "CI run 316",
    elapsed: "4m",
    command: "gh run view 316",
    exitCode: 0,
    output: "completed",
});

test("a wake steered into a turn leaves it unattended: the sandbox is not somebody at the composer", () => {
    const run = liveRun("c-wake");
    registerTurn("c-wake", { abort: () => {}, steering: new SteeringQueue() });
    expect(steerTurn("c-wake", { text: WAKE, voice: "sandbox" })).toBe(true);
    expect(turnSteered("c-wake")).toBe(false);
    run.release();
});

test("a wake steered into a live turn becomes its notice row, where before it reached the model and nobody else", () => {
    const run = liveRun("c-row");
    registerTurn("c-row", { abort: () => {}, steering: new SteeringQueue() });
    steerTurn("c-row", { text: WAKE, voice: "sandbox" });
    const rows = turnRunOf("c-row")?.rows ?? [];
    expect(rows.at(-1)).toMatchObject({ role: "notice", watchWake: { outcome: "met", note: "CI run 316" } });
    expect(turnRunOf("c-row")?.steerRows).toEqual([]);
    run.release();
});

test("a peer's message steered in is drawn as the peer's, and taints the turn it lands in", () => {
    const run = liveRun("c-peer");
    registerTurn("c-peer", { abort: () => {}, steering: new SteeringQueue() });
    publishTurnTaint("c-peer", createTurnTaint());
    const prompt = peerMessagePrompt({ from: "sharp-shale-htw8", title: "Bun migration", message: "the sweep is done" });
    expect(steerTurn("c-peer", { text: prompt, voice: "agent", outside: "agent:sharp-shale-htw8" })).toBe(true);
    expect(turnRunOf("c-peer")?.rows.at(-1)).toMatchObject({ role: "notice", agentWords: { kind: "peer", from: "sharp-shale-htw8" } });
    expect(conversationTaintSource("c-peer")).toBe("agent:sharp-shale-htw8");
    expect(turnSteered("c-peer")).toBe(false);
    clearTurnTaint("c-peer");
    run.release();
});

test("a person's steer is framed by the route that took it, so the registry adds no second row", () => {
    const run = liveRun("c-person");
    registerTurn("c-person", { abort: () => {}, steering: new SteeringQueue() });
    const before = turnRunOf("c-person")?.rows.length;
    steerTurn("c-person", person("try the other branch"));
    expect(turnRunOf("c-person")?.rows.length).toBe(before);
    run.release();
});
