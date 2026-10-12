import { type ExitRecord, exitSentence, reasonForCode } from "./last-exit.js";

const NOW = Date.parse("2026-10-11T12:00:00Z");
const base: ExitRecord = { pid: 41, version: "1.400.0", startedAt: "2026-10-11T08:00:00.000Z", reason: "running" };

test("an exit code reads as the way the agent left: a signal is a stop, 75 a takeover, 0 nothing to serve, the rest a crash", () => {
    expect(reasonForCode(143)).toEqual({ reason: "stopped", detail: "signal SIGTERM" });
    expect(reasonForCode(75).reason).toBe("replaced");
    expect(reasonForCode(0).reason).toBe("retired");
    expect(reasonForCode(1)).toEqual({ reason: "crash", detail: "exit code 1" });
});

test("a recorded exit is said with its time and detail", () => {
    expect(exitSentence({ ...base, reason: "watchdog", at: "2026-10-11T09:00:00.000Z", detail: "event loop stalled for 181 s" }, NOW, 3_600_000)).toBe(
        "the agent before this one (pid 41, 1.400.0, started 2026-10-11T08:00:00.000Z) ended at 2026-10-11T09:00:00.000Z: its watchdog killed it, the event loop having stopped answering (event loop stalled for 181 s).",
    );
    expect(exitSentence({ ...base, reason: "update", detail: "for the update to 1.401.0" }, NOW, 3_600_000)).toContain("restarted for an update (for the update to 1.401.0)");
});

// The computer's boot time is the one witness left when nothing recorded the exit.
test("a record nobody closed is a restart of the computer when it booted since, else a kill from outside", () => {
    const alive = { ...base, aliveAt: "2026-10-11T10:00:00.000Z" };
    expect(exitSentence(alive, NOW, 30 * 60_000)).toContain("the computer has booted since (2026-10-11T11:30:00.000Z)");
    expect(exitSentence(alive, NOW, 5 * 3_600_000)).toContain("ended without recording why: killed from outside");
    // No stamp yet: its start is the last time it is known to have been alive.
    expect(exitSentence(base, NOW, 30 * 60_000)).toContain("last alive at 2026-10-11T08:00:00.000Z");
});
