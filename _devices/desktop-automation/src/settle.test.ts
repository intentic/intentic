import { type SettleDeps, type SettleTiming, waitForScreenToSettle } from "./settle.js";

/* The confirming screenshot waits for the screen to change and then hold still, instead of a fixed beat that was too
   long for a redraw that lands at once and too short for an app that reacts late (2026-10-20). Reads are digests from a
   hand-written sequence; time is a hand-driven clock, each read costing `readMs`. */

const TIMING: SettleTiming = { maxMs: 1_500, quietMs: 80, pollMs: 50 };

const run = async (digests: readonly string[], baseline: string | undefined, readMs = 10, timing = TIMING) => {
    let at = 0;
    let reads = 0;
    const deps: SettleDeps = { now: () => at, sleep: async (ms) => void (at += ms) };
    const read = async (): Promise<string> => {
        at += readMs;
        const digest = digests[Math.min(reads, digests.length - 1)] ?? "";
        reads += 1;
        return digest;
    };
    const outcome = await waitForScreenToSettle(read, baseline, timing, deps);
    return { outcome, elapsed: at, reads };
};

test("a screen that changes and holds still ends the wait early", async () => {
    const result = await run(["before", "menu", "menu", "menu", "menu"], "before");
    expect(result.outcome).toBe("settled");
    expect(result.elapsed).toBeLessThan(400);
});

test("an app that reacts after the old 400 ms beat is still waited for, not called unchanged", async () => {
    // 10 reads of the old frame (600 ms at 60 ms a look), then the change.
    const digests = [...Array.from({ length: 10 }, () => "before"), "dialog", "dialog", "dialog", "dialog"];
    const result = await run(digests, "before");
    expect(result.outcome).toBe("settled");
    expect(result.elapsed).toBeGreaterThan(400);
    expect(result.elapsed).toBeLessThanOrEqual(TIMING.maxMs);
});

test("a screen that never moves runs to the cap and says so", async () => {
    const result = await run(["before"], "before");
    expect(result.outcome).toBe("unchanged");
    expect(result.elapsed).toBeLessThanOrEqual(TIMING.maxMs);
});

test("a screen that never holds still (a video) is cut off at the cap", async () => {
    const result = await run(
        Array.from({ length: 200 }, (_, index) => `frame-${index}`),
        "before",
    );
    expect(result.outcome).toBe("moving");
    expect(result.elapsed).toBeLessThanOrEqual(TIMING.maxMs);
});

test("with no frame before the action, a screen holding still is enough", async () => {
    const result = await run(["now", "now", "now"], undefined);
    expect(result.outcome).toBe("settled");
});

test("a slow read (adb) with no quiet window: two equal reads in a row, and no read started past the cap", async () => {
    const phone: SettleTiming = { maxMs: 700, quietMs: 0, pollMs: 0 };
    const settled = await run(["before", "app", "app"], "before", 200, phone);
    expect(settled).toEqual({ outcome: "settled", elapsed: 600, reads: 3 });
    const capped = await run(["before"], "before", 200, phone);
    // Three reads fit; a fourth would end at 800, past the cap, so it is not started.
    expect(capped).toEqual({ outcome: "unchanged", elapsed: 600, reads: 3 });
});
