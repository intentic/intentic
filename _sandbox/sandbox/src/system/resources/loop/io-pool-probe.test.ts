import { ioPoolState, startIoPoolProbe } from "./io-pool-probe.js";

const quiet = { warn: () => undefined, info: () => undefined };

test("a first stat answered is a pool answering, read back as /health reads it", () => {
    const pending: (() => void)[] = [];
    const probe = startIoPoolProbe(quiet, { probe: (done) => void pending.push(done), now: () => 0, everyMs: 86_400_000 });
    expect(pending).toHaveLength(1);
    expect(probe.state()).toEqual({ state: "answering", stalls: 0 });
    pending.shift()?.();
    expect(probe.state()).toEqual({ state: "answering", lastMs: 0, stalls: 0 });
    expect(ioPoolState()).toEqual(probe.state());
    probe.stop();
});

// A pool whose answers the test hands back by hand, on a clock it moves by hand.
test("only one stat is ever in flight, however long the pool holds it", async () => {
    let clock = 0;
    const pending: (() => void)[] = [];
    const warned: unknown[] = [];
    const told: unknown[] = [];
    const probe = startIoPoolProbe(
        { warn: (fields: unknown) => void warned.push(fields), info: (fields: unknown) => void told.push(fields) },
        { probe: (done) => void pending.push(done), now: () => clock, everyMs: 5, stalledAfterMs: 1_000 },
    );
    pending.shift()?.();
    // The timer sends the next stat; it hangs.
    await Bun.sleep(20);
    expect(pending).toHaveLength(1);
    clock += 999;
    await Bun.sleep(20);
    expect(probe.state().state).toBe("answering");
    clock += 1;
    await Bun.sleep(20);
    // Many ticks later, still the one stat, and the stall said once.
    expect(pending).toHaveLength(1);
    expect(probe.state()).toMatchObject({ state: "stalled", pendingMs: 1_000, stalls: 1 });
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatchObject({ ioPool: { pendingMs: 1_000, stalls: 1 } });

    clock += 4_000;
    pending.shift()?.();
    expect(told).toEqual([{ ioPool: { tookMs: 5_000, stalls: 1 } }]);
    expect(probe.state()).toEqual({ state: "answering", lastMs: 5_000, stalls: 1 });
    probe.stop();
    expect(ioPoolState()).toBeUndefined();
});
