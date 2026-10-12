import { createHeldAsks, type HeldAnswer } from "./held-asks.js";
import { opt } from "../opt.js";
import { createHeldCards, type HeldOutcome } from "./held-cards.js";

// One gate's card lifecycle, driven by hand: the card is answered when the test says, the turn ends when it says, and
// the close holds for the card the way agent/run/placement/turn-close.ts does.

const deferred = <T>() => Promise.withResolvers<T>();

const APPROVED: HeldAnswer<string> = { answer: "go", outcome: { decision: "approved" } };
const told = (outcome: HeldOutcome): string | undefined => (outcome.decision === "approved" ? "make the same call again" : undefined);

const harness = () => {
    const wakes: string[] = [];
    const held = createHeldCards(async (_conversationId, prompt) => void wakes.push(prompt));
    const asks = createHeldAsks<string>(60_000);
    let raised = 0;
    const card = deferred<HeldAnswer<string>>();
    const turn = deferred<void>();
    const ended: AbortSignal[] = [];
    const toHold = {
        raise: (signal: AbortSignal) => {
            raised += 1;
            ended.push(signal);
            signal.addEventListener("abort", () => card.resolve({ answer: "refused: turn over", outcome: { decision: "unanswered" } }));
            return card.promise;
        },
        told,
        held,
        finished: turn.promise,
    };
    const callOf = (budgetMs: number | undefined = 1_000) => ({
        conversationId: "c",
        key: "rm -rf build",
        waiting: () => "still waiting",
        ...opt("budgetMs", budgetMs),
        arrivedAt: Date.now(),
    });
    return { wakes, held, asks, card, turn, ended, toHold, callOf, raisedCount: () => raised };
};

test("an answer inside the budget is the call's, and the same call again raises a fresh card", async () => {
    const h = harness();
    const asking = h.asks.ask(h.callOf(), h.toHold);
    h.card.resolve(APPROVED);
    expect(await asking).toBe("go");
    expect(h.asks.reattach(h.callOf())).toBe(undefined);
    // Collected, so the close has nothing to hold for and wakes nobody.
    expect(h.held.open("c")).toEqual([]);
});

test("a budget that runs out says still-waiting and leaves the card up; the same call again collects the late answer without a second card", async () => {
    const h = harness();
    expect(await h.asks.ask(h.callOf(0), h.toHold)).toBe("still waiting");
    expect(h.held.open("c")).toHaveLength(1);
    const again = h.asks.reattach(h.callOf());
    h.card.resolve(APPROVED);
    expect(await again).toBe("go");
    expect(h.raisedCount()).toBe(1);
    expect(h.asks.reattach(h.callOf())).toBe(undefined);
});

test("a card answered long after its call gave up still approves: no clock refuses it", async () => {
    jest.useFakeTimers();
    try {
        const h = harness();
        const asking = h.asks.ask(h.callOf(45_000), h.toHold);
        jest.advanceTimersByTime(45_000);
        expect(await asking).toBe("still waiting");
        // Well past the ten minutes cards used to be refused at.
        jest.advanceTimersByTime(3 * 60 * 60_000);
        expect(h.ended[0]?.aborted).toBe(false);
        h.card.resolve(APPROVED);
        expect(await h.asks.reattach(h.callOf(undefined))).toBe("go");
    } finally {
        jest.useRealTimers();
    }
});

test("a late approval after the call gave up wakes the conversation, and the repeated call passes once without a second card", async () => {
    const h = harness();
    expect(await h.asks.ask(h.callOf(0), h.toHold)).toBe("still waiting");
    // The agent ends its turn; the close holds for the card it left up.
    const closing = h.held.hold("c", undefined);
    h.card.resolve(APPROVED);
    await closing;
    h.turn.resolve();
    await h.turn.promise;
    expect(h.wakes).toEqual(["make the same call again\n\nThen continue the task."]);

    // The turn the wake started makes the same call: the carried yes, used once.
    expect(await h.asks.reattach(h.callOf())).toBe("go");
    expect(h.asks.reattach(h.callOf())).toBe(undefined);
    expect(h.raisedCount()).toBe(1);
});

test("a stop while the close holds settles the card unanswered and wakes nobody; the next call asks afresh", async () => {
    const h = harness();
    expect(await h.asks.ask(h.callOf(0), h.toHold)).toBe("still waiting");
    const stop = new AbortController();
    const closing = h.held.hold("c", stop.signal);
    stop.abort();
    await closing;
    await h.card.promise;
    expect(h.wakes).toEqual([]);
    expect(h.asks.reattach(h.callOf())).toBe(undefined);
});

test("an answer nobody came back for is dropped when its turn ends", async () => {
    const h = harness();
    expect(await h.asks.ask(h.callOf(0), h.toHold)).toBe("still waiting");
    h.card.resolve(APPROVED);
    h.turn.resolve();
    await h.turn.promise;
    await Promise.resolve();
    expect(h.asks.reattach(h.callOf())).toBe(undefined);
});

test("the caller's own signal ends its wait, never the card", async () => {
    const h = harness();
    const gone = new AbortController();
    const asking = h.asks.ask({ ...h.callOf(undefined), signal: gone.signal }, h.toHold);
    gone.abort();
    expect(await asking).toBe("still waiting");
    expect(h.ended[0]?.aborted).toBe(false);
    expect(h.held.open("c")).toHaveLength(1);
});

test("keys are the gate's own and the conversation's: two gates or two conversations never share a card", async () => {
    const h = harness();
    expect(await h.asks.ask(h.callOf(0), h.toHold)).toBe("still waiting");
    expect(createHeldAsks<string>().reattach(h.callOf())).toBe(undefined);
    expect(h.asks.reattach({ ...h.callOf(), conversationId: "other" })).toBe(undefined);
});

test("a carried yes nobody came back for goes when its time is up", async () => {
    jest.useFakeTimers();
    try {
        const h = harness();
        const asking = h.asks.ask(h.callOf(0), h.toHold);
        jest.advanceTimersByTime(0);
        expect(await asking).toBe("still waiting");
        const closing = h.held.hold("c", undefined);
        h.card.resolve(APPROVED);
        await closing;
        jest.advanceTimersByTime(60_000);
        expect(h.asks.reattach(h.callOf())).toBe(undefined);
    } finally {
        jest.useRealTimers();
    }
});
