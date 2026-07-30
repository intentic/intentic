import { expect, test } from "vitest";
import { nextRestartDelay, RESTART_DELAY_BASE_MS, RESTART_DELAY_CAP_MS } from "./translator.js";

// The restart ladder in one property: crash-on-arrival climbs, a stable run resets. This policy is what keeps
// a proxy that exits immediately (a taken port, a bad binary) from being respawned every 5s forever.

test("consecutive fast exits double the delay up to the cap", () => {
    let delay = RESTART_DELAY_BASE_MS;
    const seen: number[] = [];
    for (let i = 0; i < 8; i += 1) {
        delay = nextRestartDelay(delay, 100);
        seen.push(delay);
    }
    expect(seen).toEqual([10_000, 20_000, 40_000, 80_000, 160_000, RESTART_DELAY_CAP_MS, RESTART_DELAY_CAP_MS, RESTART_DELAY_CAP_MS]);
});

test("a run that stayed up resets the ladder", () => {
    expect(nextRestartDelay(RESTART_DELAY_CAP_MS, 61_000)).toBe(RESTART_DELAY_BASE_MS);
});
