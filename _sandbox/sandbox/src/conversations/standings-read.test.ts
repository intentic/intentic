import { standingsForRead } from "./standings-read.js";

// A roster read after a long idle: the probe re-reads every agent's branch on a cold disk. The read answers with the
// standings in hand once its patience is spent, and the probe it started keeps going, to answer by broadcast.
test("a roster read waits on a slow probe only as long as its patience, and leaves the probe running", async () => {
    let finished = false;
    const slow = new Promise<void>((resolve) => setTimeout(resolve, 200)).then(() => {
        finished = true;
    });
    const started = Date.now();
    await standingsForRead({ refreshStandings: () => slow }, 20);
    expect(Date.now() - started).toBeLessThan(150);
    expect(finished).toBe(false);
    await slow;
    expect(finished).toBe(true);
});

test("a probe that answers in time is the read's answer, its failure included", async () => {
    const order: string[] = [];
    await standingsForRead({ refreshStandings: async () => void order.push("probed") }, 1_000);
    order.push("answered");
    expect(order).toEqual(["probed", "answered"]);
    await expect(standingsForRead({ refreshStandings: () => Promise.reject(new Error("broadcast failed")) }, 1_000)).rejects.toThrow("broadcast failed");
});
