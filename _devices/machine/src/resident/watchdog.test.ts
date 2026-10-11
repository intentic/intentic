import { pausedAcross, stallLine, stalledFor, WATCHDOG_PING_MS, WATCHDOG_STALL_MS } from "./watchdog.js";

const NOW = 1_800_000_000_000;

// The one decision the Worker makes, on the main thread's last ping.
test("the loop counts as stuck only once it has gone the whole limit without a ping", () => {
    expect(stalledFor(NOW - WATCHDOG_STALL_MS + 1, NOW, WATCHDOG_STALL_MS)).toBeUndefined();
    expect(stalledFor(NOW - WATCHDOG_STALL_MS, NOW, WATCHDOG_STALL_MS)).toBe(180);
    expect(stalledFor(NOW - 4 * 60_000 - 400, NOW, WATCHDOG_STALL_MS)).toBe(240);
    // A clock that stepped back is not a stall.
    expect(stalledFor(NOW + 60_000, NOW, WATCHDOG_STALL_MS)).toBeUndefined();
});

// Many pings fit in the limit, so one late timer (a sleeping laptop's first tick) is never read as a hang.
test("the main loop pings many times within the limit", () => {
    expect(WATCHDOG_STALL_MS / WATCHDOG_PING_MS).toBeGreaterThanOrEqual(30);
});

test("the line it leaves says what happened, timestamped like every other line of the log", () => {
    expect(stallLine(181, new Date(NOW))).toBe(
        `[${new Date(NOW).toISOString()}] event loop stalled for 181 s; exiting so the supervisor restarts the agent\n`,
    );
});

// A sleep holds the Worker's own checks apart too, which a hung main loop never does: that gap restarts the count.
test("checks held far apart are a pause of the whole process, not a hang; a late timer is neither", () => {
    const paused = (gapMs: number, checkMs = WATCHDOG_PING_MS, limitMs = WATCHDOG_STALL_MS): boolean => pausedAcross(NOW - gapMs, NOW, checkMs, limitMs);
    expect(paused(4 * 60_000)).toBe(true);
    expect(paused(15_000)).toBe(true);
    expect(paused(5_000)).toBe(false);
    expect(paused(14_000)).toBe(false);
    // Short intervals still need three seconds, so a busy machine's jitter is not a pause...
    expect(paused(2_000, 50, 60_000)).toBe(false);
    // ...unless the limit is shorter than that: any pause long enough to reach the limit is one.
    expect(paused(500, 200, 1_000)).toBe(true);
    expect(paused(400, 200, 1_000)).toBe(false);
    // A clock that stepped back is not a pause.
    expect(pausedAcross(NOW + 60_000, NOW, WATCHDOG_PING_MS, WATCHDOG_STALL_MS)).toBe(false);
});
