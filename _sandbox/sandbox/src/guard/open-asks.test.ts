import { createOpenAsks } from "./open-asks.js";

// A card the test answers by hand, and a turn it ends by hand.
const deferred = <T>() => Promise.withResolvers<T>();

test("an answer inside the budget is returned and collected, so the same call again raises a fresh card", async () => {
    const asks = createOpenAsks<string | undefined>();
    const card = deferred<string | undefined>();
    asks.hold("k", card.promise, deferred<void>().promise);
    card.resolve("refused");
    expect(await asks.await("k", card.promise, 1_000, "waiting")).toBe("refused");
    expect(asks.get("k")).toBe(undefined);
});

test("a budget that runs out says still-waiting and leaves the card up, and the next call collects the late answer", async () => {
    const asks = createOpenAsks<string | undefined>();
    const card = deferred<string | undefined>();
    asks.hold("k", card.promise, deferred<void>().promise);
    expect(await asks.await("k", card.promise, 0, "waiting")).toBe("waiting");
    expect(asks.get("k")).toBe(card.promise);
    card.resolve(undefined);
    expect(await asks.await("k", card.promise, 1_000, "waiting")).toBe(undefined);
    expect(asks.get("k")).toBe(undefined);
});

test("an answer nobody came back for is dropped when its turn ends", async () => {
    const asks = createOpenAsks<string | undefined>();
    const turn = deferred<void>();
    const card = deferred<string | undefined>();
    asks.hold("k", card.promise, turn.promise);
    turn.resolve();
    await turn.promise;
    expect(asks.get("k")).toBe(undefined);
});

test("collecting or ending an old card under a key leaves a newer card under the same key alone", async () => {
    const asks = createOpenAsks<string | undefined>();
    const oldTurn = deferred<void>();
    const old = deferred<string | undefined>();
    asks.hold("k", old.promise, oldTurn.promise);
    const newer = deferred<string | undefined>();
    asks.hold("k", newer.promise, deferred<void>().promise);
    old.resolve("old");
    expect(await asks.await("k", old.promise, 1_000, "waiting")).toBe("old");
    oldTurn.resolve();
    await oldTurn.promise;
    expect(asks.get("k")).toBe(newer.promise);
});

test("keys are the gate's own: two gates never share a card", () => {
    const one = createOpenAsks<string>();
    const two = createOpenAsks<string>();
    const card = deferred<string>();
    one.hold("k", card.promise, deferred<void>().promise);
    expect(two.get("k")).toBe(undefined);
});

test("a carried answer outlives its turn's end, is used once, and goes when its time is up", async () => {
    jest.useFakeTimers();
    try {
        const asks = createOpenAsks<string | undefined>();
        const turn = deferred<void>();
        const card = deferred<string | undefined>();
        asks.hold("k", card.promise, turn.promise);
        card.resolve(undefined);
        asks.carry("k", card.promise, 60_000);
        turn.resolve();
        await turn.promise;
        const carried = asks.get("k");
        expect(carried).toBeInstanceOf(Promise);
        expect(await asks.await("k", carried ?? card.promise, 1_000, "waiting")).toBe(undefined);
        expect(asks.get("k")).toBe(undefined);

        // One nobody came back for is dropped when its time is up.
        asks.carry("k", card.promise, 60_000);
        expect(asks.get("k")).toBeInstanceOf(Promise);
        jest.advanceTimersByTime(60_000);
        expect(asks.get("k")).toBe(undefined);
    } finally {
        jest.useRealTimers();
    }
});
