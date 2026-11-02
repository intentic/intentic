import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { standingsForRead } from "./standings-read.js";

// A roster read after a long idle: the probe re-reads every agent's branch on a cold disk. The read answers with the
// standings in hand once its patience is spent, and the probe it started keeps going, to answer by broadcast.
test("a roster read waits on a slow probe only as long as its patience, and leaves the probe running", async () => {
    jest.useFakeTimers();
    const probe = Promise.withResolvers<void>();
    let finished = false;
    const slow = probe.promise.then(() => { finished = true; });
    try {
        let answered = false;
        const read = standingsForRead({ refreshStandings: () => slow }, 20).then(() => { answered = true; });
        await advanceTimersByTimeAsync(19);
        expect(answered).toBe(false);
        await advanceTimersByTimeAsync(1);
        await read;
        expect(finished).toBe(false);
        probe.resolve();
        await slow;
        expect(finished).toBe(true);
    } finally {
        probe.resolve();
        jest.useRealTimers();
    }
});

test("a probe that answers in time is the read's answer, its failure included", async () => {
    const order: string[] = [];
    await standingsForRead({ refreshStandings: async () => void order.push("probed") }, 1_000);
    order.push("answered");
    expect(order).toEqual(["probed", "answered"]);
    await expect(standingsForRead({ refreshStandings: () => Promise.reject(new Error("broadcast failed")) }, 1_000)).rejects.toThrow("broadcast failed");
});
