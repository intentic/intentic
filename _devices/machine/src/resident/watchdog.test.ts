import { pausedAcross, sleepLine, stallLine, stalledFor, WALL_JUMP_MS, wallJump, WATCHDOG_PING_MS, WATCHDOG_STALL_MS } from "./watchdog.js";

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
    // A real stall minutes after a sleep still kills, and says how soon after the sleep it came.
    expect(stallLine(181, new Date(NOW), 240)).toContain("stalled for 181 s (240 s after a suspected sleep/resume); exiting");
    expect(sleepLine(3600, new Date(NOW))).toBe(
        `[${new Date(NOW).toISOString()}] watchdog: the agent was paused for 3600 s (suspected sleep/resume, or the clock was set forward); not a stall, the count starts again\n`,
    );
});

// Linux's monotonic clock stops while the machine sleeps: checks come back on time, and only the wall clock says the
// machine was away. The difference between the two clocks is that time; ordinary jitter is none of it.
test("the wall clock running ahead of the monotonic one between two checks is a sleep; a late timer is not", () => {
    const MONO = 1_000;
    expect(wallJump(MONO, MONO + WATCHDOG_PING_MS, NOW, NOW + WATCHDOG_PING_MS)).toBe(0);
    expect(wallJump(MONO, MONO + WATCHDOG_PING_MS, NOW, NOW + WATCHDOG_PING_MS + 3_600_000)).toBe(3_600_000);
    // A timer firing late moves both clocks alike.
    expect(wallJump(MONO, MONO + 9_000, NOW, NOW + 9_050)).toBeLessThan(WALL_JUMP_MS);
    // A clock set back is no sleep.
    expect(wallJump(MONO, MONO + WATCHDOG_PING_MS, NOW, NOW - 60_000)).toBeLessThan(0);
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
