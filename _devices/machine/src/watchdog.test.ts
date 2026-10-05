import { stallLine, stalledFor, WATCHDOG_PING_MS, WATCHDOG_STALL_MS } from "./watchdog.js";

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
