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

    it("holds a replay handed over whole ahead of what is pushed, bounding only what lands after it", () => {
        const onCut = jest.fn((_unsent: number) => undefined);
        const backlog = frameBacklog<number>(onCut, { frames: 3 });
        backlog.seed([1, 2, 3, 4, 5, 6]);
        backlog.push(7);
        expect(onCut).not.toHaveBeenCalled();
        expect(backlog.shift()?.frame).toBe(1);

        // Taking a replayed frame frees no room for what lands: the bound is on pushed frames alone.
        for (const frame of [8, 9]) {
            backlog.push(frame);
        }
        expect(onCut).not.toHaveBeenCalled();
        backlog.push(10);
        expect(onCut.mock.calls).toEqual([[9]]);
        expect(backlog.shift()).toBe(undefined);
    });

    it("lets a pushed frame in once a reader has taken the replay, and reads the replay for the wait bound", () => {
        const time = clock();
        const onCut = jest.fn((_unsent: number) => undefined);
        const backlog = frameBacklog<string>(onCut, { frames: 1, waitMs: 1_000, now: time.now });
        backlog.seed(["session", "usage"]);
        expect(backlog.shift()?.frame).toBe("session");
        expect(backlog.shift()?.frame).toBe("usage");
        backlog.push("delta");
        expect(backlog.shift()?.frame).toBe("delta");

        backlog.seed(["usage"]);
        time.advanceMs(1_001);
        backlog.push("delta");
        expect(onCut.mock.calls).toEqual([[2]]);
    });

    it("stamps each frame with the clock it was produced at", () => {
        const time = clock();
        const backlog = frameBacklog<string>(() => undefined, { now: time.now });
        time.advanceMs(7);
        backlog.push("hello");
        expect(backlog.shift()).toEqual({ frame: "hello", at: 7_000_000n });
    });
});
