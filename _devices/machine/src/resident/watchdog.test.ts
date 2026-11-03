import { classifyPause, memoryPhrase, NO_MEMORY, parseMeminfoAvailableMb, parsePressure, parseSwapPages, parseWindowsAnswer, pauseCauseLine, type PauseReport, type PowerEvent } from "./pause-cause.js";
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
    expect(stallLine(181, new Date(NOW), 240)).toContain("stalled for 181 s (240 s after a pause of the whole agent); exiting");
    expect(sleepLine(3600, new Date(NOW))).toBe(
        `[${new Date(NOW).toISOString()}] watchdog: the agent was paused for 3600 s (a sleep, a freeze, or the clock set forward; checking which); not a stall, the count starts again\n`,
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

/* What the pause was (pause-cause.ts). 2026-11-02: a Windows PC with 1 GB free froze for 43 s and the log said "suspected
   sleep/resume". Windows' monotonic clock counts through a sleep, so only its event log tells the two apart. */
const PAUSE: PauseReport = { kind: "paused", seconds: 43, from: NOW - 43_000, to: NOW, held: true };
const at = (ms: number): string => new Date(ms).toISOString();

test("on Windows a pause with a sleep or wake logged around it was a sleep, and one without was a freeze", () => {
    const events: PowerEvent[] = [
        { kind: "sleep", at: NOW - 41_000 },
        { kind: "wake", at: NOW - 40_000 },
        { kind: "wake", at: NOW + 2_000, troubleshooter: true },
    ];
    // The troubleshooter's wake is the one whose time is the wake's, Kernel-Power 107 being stamped going down.
    expect(classifyPause(PAUSE, true, events)).toEqual({ kind: "sleep", sleptAt: NOW - 41_000, wokeAt: NOW + 2_000 });
    expect(classifyPause(PAUSE, true, [])).toEqual({ kind: "freeze", why: "no-power-events" });
    // A sleep the day before is not this pause's.
    expect(classifyPause(PAUSE, true, [{ kind: "sleep", at: NOW - 86_400_000 }])).toEqual({ kind: "freeze", why: "no-power-events" });
    // Only the wall clock moved, and no sleep was logged: the clock was set forward.
    expect(classifyPause({ ...PAUSE, held: false }, true, [])).toEqual({ kind: "clock" });
    // An event log that did not answer is said as that, never as a freeze.
    expect(classifyPause(PAUSE, true, undefined, "timed out")).toEqual({ kind: "unknown", why: "the Windows event log did not answer (timed out)" });
});

test("elsewhere the clocks tell: the monotonic clock stops in a sleep, so its gap is a freeze", () => {
    expect(classifyPause(PAUSE, false, undefined)).toEqual({ kind: "freeze", why: "monotonic" });
    expect(classifyPause({ ...PAUSE, held: false }, false, undefined)).toEqual({ kind: "sleep-or-clock" });
});

test("the follow-up line says what it was and how memory stood, in the watchdog's style", () => {
    const memory = { ...NO_MEMORY, freeMb: 1_050, totalMb: 32_405, paging: 2_300 };
    expect(pauseCauseLine(PAUSE, { kind: "freeze", why: "no-power-events" }, memory, new Date(NOW))).toBe(
        `[${at(NOW)}] watchdog: the 43 s pause from ${at(NOW - 43_000)} was not a sleep (Windows logged no sleep or wake around it): a freeze, the machine or this process held up; memory: 1,050 MB free of 32,405 MB, 2,300 pages/s paging\n`,
    );
    expect(pauseCauseLine(PAUSE, { kind: "sleep", sleptAt: NOW - 41_000, wokeAt: NOW }, NO_MEMORY, new Date(NOW))).toBe(
        `[${at(NOW)}] watchdog: the 43 s pause from ${at(NOW - 43_000)} was a sleep: Windows went to sleep at ${at(NOW - 41_000)} and woke at ${at(NOW)}\n`,
    );
    expect(pauseCauseLine(PAUSE, { kind: "sleep", sleptAt: undefined, wokeAt: NOW }, NO_MEMORY, new Date(NOW))).toContain("was a sleep: Windows woke at");
    expect(pauseCauseLine(PAUSE, { kind: "unknown", why: "the Windows event log did not answer (timed out)" }, NO_MEMORY, new Date(NOW))).toContain(
        "could not be told a sleep or a freeze: the Windows event log did not answer (timed out)",
    );
    expect(memoryPhrase({ ...NO_MEMORY, freeMb: 900, swapping: 12, pressure: 35.5 })).toBe("; memory: 900 MB free, 12 pages/s swapped, memory pressure 35.5% over the last minute");
});

// The PowerShell script's tagged lines, as a real Windows 11 PC printed them.
test("the Windows answer is read for its memory and its power events; a log that failed is not an empty one", () => {
    const answer = parseWindowsAnswer(
        [
            "memory|1156|74528",
            "event|Microsoft-Windows-Power-Troubleshooter|1|2026-09-09T06:12:16.1531323Z",
            "event|Microsoft-Windows-Kernel-Power|107|2026-09-08T23:32:53.3671360Z",
            "event|Microsoft-Windows-Kernel-Power|42|2026-09-08T23:32:37.7702071Z",
            "event|Microsoft-Windows-Kernel-Power|41|2026-09-08T23:00:00.0000000Z",
        ].join("\r\n"),
    );
    expect(answer.memory).toEqual({ ...NO_MEMORY, freeMb: 1156, paging: 74_528 });
    expect(answer.events).toEqual([
        { kind: "wake", at: Date.parse("2026-09-09T06:12:16.153Z"), troubleshooter: true },
        { kind: "wake", at: Date.parse("2026-09-08T23:32:53.367Z") },
        { kind: "sleep", at: Date.parse("2026-09-08T23:32:37.770Z") },
    ]);
    expect(parseWindowsAnswer("memory|2048|\nevents|none\n")).toEqual({ events: [], why: "no answer", memory: { ...NO_MEMORY, freeMb: 2048 } });
    expect(parseWindowsAnswer("memory-error|Invalid class\nevents-error|Access is denied")).toEqual({ events: undefined, why: "Access is denied", memory: NO_MEMORY });
});

test("Linux's memory is read from /proc", () => {
    expect(parseMeminfoAvailableMb("MemTotal:       16303536 kB\nMemFree:          512000 kB\nMemAvailable:    1075200 kB\n")).toBe(1050);
    expect(parseMeminfoAvailableMb("MemTotal: 1 kB\n")).toBeUndefined();
    expect(parseSwapPages("pgpgin 1\npswpin 120\npswpout 30\n")).toBe(150);
    expect(parsePressure("some avg10=12.50 avg60=35.20 avg300=4.00 total=123\nfull avg10=1.00 avg60=2.00 avg300=0.00 total=9\n")).toBe(35.2);
    expect(parsePressure("")).toBeUndefined();
});
