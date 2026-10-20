import { setTimeout as sleep } from "node:timers/promises";
import { captureDigest, type FrameLog } from "./frames.js";
import type { Desktop } from "./types.js";
import { reshootRegion } from "./view.js";

// WAITING FOR A SCREEN TO SHOW WHAT AN ACTION DID BEFORE THE CONFIRMING SCREENSHOT (2026-10-20). A fixed beat was
// both too long (a click that redraws at once still waited it out) and too short (an app that reacts after it was
// answered "the screen did not change"). No screen raises an event for "done drawing", so the wait reads cheap digests of
// it and ends once one differs from the frame before the action and the next one is the same: changed, then still.

export interface SettleTiming {
    // The cap: past it the confirming screenshot is taken whatever the screen is doing (a video never holds still).
    readonly maxMs: number;
    // How long a changed screen must hold still to count as done.
    readonly quietMs: number;
    // The pause between reads; a slow read (adb) is its own pause on top.
    readonly pollMs: number;
}

export type SettleOutcome = "settled" | "unchanged" | "moving";

export interface SettleDeps {
    readonly now: () => number;
    readonly sleep: (ms: number) => Promise<void>;
}

const realDeps: SettleDeps = { now: Date.now, sleep: async (ms) => void (await sleep(ms)) };

// `settled`: changed and held still. `unchanged`: never moved off `baseline` within the cap (the action did nothing
// visible, or does it later). `moving`: still changing at the cap. A read is not started when the last one says it would
// end past the cap, so a slow screen costs the cap, not the cap plus a read.
export const waitForScreenToSettle = async (
    read: () => Promise<string>,
    baseline: string | undefined,
    timing: SettleTiming,
    deps: SettleDeps = realDeps,
): Promise<SettleOutcome> => {
    const deadline = deps.now() + timing.maxMs;
    let last: string | undefined;
    let seenAt = 0;
    let readMs = 0;
    while (deps.now() + readMs < deadline) {
        const started = deps.now();
        const digest = await read();
        const at = deps.now();
        readMs = at - started;
        if (digest !== baseline || baseline === undefined) {
            if (digest !== last) {
                last = digest;
                seenAt = at;
            } else if (at - seenAt >= timing.quietMs) {
                return "settled";
            }
        }
        if (deps.now() + timing.pollMs + readMs >= deadline) {
            break;
        }
        await deps.sleep(timing.pollMs);
    }
    return last === undefined ? "unchanged" : "moving";
};

// The desktop's timing. The cap is the most an app is given to react (2026-10-20); the old fixed beat was 400 ms,
// which a menu opening on a busy machine outran.
export const DESKTOP_SETTLE: SettleTiming = { maxMs: 1_500, quietMs: 80, pollMs: 50 };

// Waits for the region the confirming screenshot (reshoot) will capture to settle after an action.
export const settle = async (screen: Desktop, log: FrameLog): Promise<SettleOutcome> => {
    const region = await reshootRegion(screen, log);
    return await waitForScreenToSettle(async () => await captureDigest(screen, region), log.latest()?.digest, DESKTOP_SETTLE);
};
