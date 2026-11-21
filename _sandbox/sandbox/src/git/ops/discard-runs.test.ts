import { createDiscardRuns } from "./discard-runs.js";

test("a second press on the same target joins the discard running, and the repo reads as discarding until it ends", async () => {
    const runs = createDiscardRuns();
    let started = 0;
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    const task = async (): Promise<void> => {
        started += 1;
        await held;
    };

    const first = runs.run("root", `["old-web/"]`, task);
    const second = runs.run("root", `["old-web/"]`, task);
    const other = runs.run("root", `["notes.md"]`, async () => undefined);

    expect(second).toBe(first);
    expect(started).toBe(1);
    expect(runs.repos()).toEqual(["root"]);
    await other;
    // The other target ended; the first still holds the repo as discarding.
    expect(runs.repos()).toEqual(["root"]);
    release();
    await first;
    expect(runs.repos()).toEqual([]);
});

test("a discard that fails still stops reading as running, and the next press starts afresh", async () => {
    const runs = createDiscardRuns();
    await expect(runs.run("app", "[]", async () => { throw new Error("git refused"); })).rejects.toThrow("git refused");
    expect(runs.repos()).toEqual([]);
    let ran = false;
    await runs.run("app", "[]", async () => {
        ran = true;
    });
    expect(ran).toBe(true);
});
