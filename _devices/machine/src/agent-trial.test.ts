import { CRASH_LOOP_STARTS, crashLooping, HEALTHY_AFTER_MS, type StartLedger, withCleanExit, withStart } from "./agent-trial.js";

/* WHEN A NEW AGENT IS GIVEN UP ON, asserted over the ledger alone: three starts of one release inside ten minutes, none
   ended by somebody asking, and that release never having stayed up for the ten minutes that prove it. */

const NOW = 1_800_000_000_000;

// `count` starts of `version`, a minute apart, the last one now.
const started = (version: string, count: number, from: StartLedger | undefined = undefined): StartLedger =>
    Array.from({ length: count }, (_, index) => index).reduce<StartLedger | undefined>(
        (ledger, index) => withStart(ledger, version, 100 + index, NOW - (count - 1 - index) * 60_000),
        from,
    ) ?? { version, starts: [] };

test("the third start inside the window, none ended cleanly, is a crash loop; the second is not", () => {
    expect(crashLooping(started("2.0.0", CRASH_LOOP_STARTS - 1), undefined, NOW)).toBe(false);
    expect(crashLooping(started("2.0.0", CRASH_LOOP_STARTS), undefined, NOW)).toBe(true);
});

// Somebody restarting the agent three times after an upgrade is not the agent crashing.
test("a start that ended because it was asked to (stop, restart, upgrade) does not count", () => {
    const ledger = withCleanExit(started("2.0.0", CRASH_LOOP_STARTS), 100);
    expect(crashLooping(ledger, undefined, NOW)).toBe(false);
});

// The ten minutes are the whole proof: a release that once held is not rolled back for crashing later.
test("a release that has already proved itself is never judged a crash loop", () => {
    expect(crashLooping(started("2.0.0", CRASH_LOOP_STARTS + 2), "2.0.0", NOW)).toBe(false);
    expect(crashLooping(started("2.0.0", CRASH_LOOP_STARTS), "1.9.0", NOW)).toBe(true);
});

test("starts older than the window are forgotten, and another release's starts never count", () => {
    const old = withStart(withStart(undefined, "2.0.0", 1, NOW - HEALTHY_AFTER_MS - 60_000), "2.0.0", 2, NOW - HEALTHY_AFTER_MS);
    expect(withStart(old, "2.0.0", 3, NOW)).toEqual({ version: "2.0.0", starts: [{ at: NOW, pid: 3 }] });
    expect(withStart(started("1.9.0", 2), "2.0.0", 3, NOW)).toEqual({ version: "2.0.0", starts: [{ at: NOW, pid: 3 }] });
});
