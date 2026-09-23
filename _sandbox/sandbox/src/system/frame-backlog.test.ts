import { frameBacklog } from "./frame-backlog.js";

// What one /events connection may hold for a consumer that is not reading, and what happens past it.

// A clock the test moves, in the same unit production reads (process.hrtime.bigint(), nanoseconds).
const clock = () => {
    let nanos = 0n;
    return { now: () => nanos, advanceMs: (ms: number) => (nanos += BigInt(ms) * 1_000_000n) };
};

describe("the /events backlog", () => {
    it("holds up to its frame bound, then drops everything and cuts once", () => {
        const onCut = jest.fn((_unsent: number) => undefined);
        const backlog = frameBacklog<number>(onCut, { frames: 3 });
        for (const frame of [1, 2, 3]) {
            backlog.push(frame);
        }
        expect(onCut).not.toHaveBeenCalled();
        expect(backlog.depth()).toBe(3);

        backlog.push(4);
        backlog.push(5);
        expect(onCut.mock.calls).toEqual([[4]]);
        expect(backlog.depth()).toBe(0);
        expect(backlog.shift()).toBe(undefined);
    });

    it("cuts a consumer whose oldest frame has waited past the bound, however few frames it holds", () => {
        const time = clock();
        const onCut = jest.fn((_unsent: number) => undefined);
        const backlog = frameBacklog<string>(onCut, { waitMs: 1_000, now: time.now });
        backlog.push("roster");
        time.advanceMs(1_000);
        backlog.push("presence");
        expect(onCut).not.toHaveBeenCalled();

        time.advanceMs(1);
        backlog.push("roster");
        expect(onCut.mock.calls).toEqual([[3]]);
    });

    it("never cuts a consumer that keeps taking its frames", () => {
        const time = clock();
        const onCut = jest.fn((_unsent: number) => undefined);
        const backlog = frameBacklog<number>(onCut, { frames: 2, waitMs: 1_000, now: time.now });
        for (let frame = 0; frame < 1_000; frame += 1) {
            backlog.push(frame);
            time.advanceMs(500);
            expect(backlog.shift()?.frame).toBe(frame);
        }
        expect(onCut).not.toHaveBeenCalled();
    });

    it("stamps each frame with the clock it was produced at", () => {
        const time = clock();
        const backlog = frameBacklog<string>(() => undefined, { now: time.now });
        time.advanceMs(7);
        backlog.push("hello");
        expect(backlog.shift()).toEqual({ frame: "hello", at: 7_000_000n });
    });
});
