import { createJobLanes, type LaneRelease } from "./job-lanes.js";

// One kind of daemon job, ordered per place (2026-11-17, the shinobi-society audit): one at a time until a run went
// well, then up to `most` at once, first come first served, never two of one key at once.

const open = new AbortController().signal;

// Settles on the next turn of the event loop, so a pending enter reads as pending.
const settledNow = async <T>(promise: Promise<T>): Promise<{ readonly value: T } | undefined> =>
    await Promise.race([promise.then((value) => ({ value })), new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 10))]);

const entered = async (promise: Promise<LaneRelease | undefined>): Promise<LaneRelease> => {
    const release = await promise;
    if (release === undefined) {
        throw new Error("not admitted");
    }
    return release;
};

test("a lane runs one at a time until a run went well, then two at once, in the order they came", async () => {
    const lanes = createJobLanes(2);
    const first = await entered(lanes.enter("chrome", undefined, open));
    const second = lanes.enter("chrome", undefined, open);
    expect(await settledNow(second)).toBeUndefined();
    expect(lanes.held("chrome")).toBe(2);
    // A first run that failed proves nothing about running two: the next still runs alone.
    first(false);
    const secondRelease = await entered(second);
    const third = lanes.enter("chrome", undefined, open);
    expect(await settledNow(third)).toBeUndefined();
    secondRelease(true);
    const thirdRelease = await entered(third);
    // Warm now: a fourth runs beside the third, and a fifth waits for one of them.
    const fourthRelease = await entered(lanes.enter("chrome", undefined, open));
    const fifth = lanes.enter("chrome", undefined, open);
    expect(await settledNow(fifth)).toBeUndefined();
    fourthRelease(true);
    (await entered(fifth))(true);
    thirdRelease(true);
    expect(lanes.held("chrome")).toBe(0);
});

test("two runs of one key never run at once, and one waiting on its key lets a later one go first", async () => {
    const lanes = createJobLanes(2);
    (await entered(lanes.enter("chrome", undefined, open)))(true);
    const inChat = await entered(lanes.enter("chrome", "chat-a", open));
    const sameChat = lanes.enter("chrome", "chat-a", open);
    const otherChat = lanes.enter("chrome", "chat-b", open);
    expect(await settledNow(sameChat)).toBeUndefined();
    const other = await settledNow(otherChat);
    expect(other).toEqual({ value: expect.any(Function) });
    inChat(true);
    (await entered(sameChat))(true);
    other?.value?.(true);
});

test("a run stopped while it waits leaves the queue, and browsers have lanes of their own", async () => {
    const lanes = createJobLanes(2);
    const running = await entered(lanes.enter("chrome", undefined, open));
    const stop = new AbortController();
    const waiting = lanes.enter("chrome", undefined, stop.signal);
    expect(await settledNow(lanes.enter("edge", undefined, open))).toEqual({ value: expect.any(Function) });
    stop.abort();
    expect(await waiting).toBeUndefined();
    expect(lanes.held("chrome")).toBe(1);
    running(false);
    expect(lanes.held("chrome")).toBe(0);
});
