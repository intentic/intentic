import type { RunnerSummary } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { credentialsTravel, placeFanOut, runnerSlots } from "./runner-scheduler.js";

/* Where a spawned agent goes when nobody chose. Every case here is a decision made thirty times during one
 * fan-out, so the cost of a wrong rule is not one misplaced agent: it is a fleet that piles everything onto
 * one machine while the others idle, which is the exact failure the feature exists to end. */

const runner = (id: string, overrides: Partial<RunnerSummary> = {}): RunnerSummary => ({
    id,
    online: true,
    parity: "current",
    facts: { cpus: 8, memoryMb: 32_768, freeDiskMb: 100_000, load: 0.1 },
    ...overrides,
});

const load = (counts: Record<string, number> = {}) => ({ inFlight: new Map(Object.entries(counts)) });

test("slots are the lower of what the cores and the memory can hold", () => {
    // Cores − 2, the local fan-out rule: the reserve is the daemon and whoever is using that machine.
    expect(runnerSlots({ cpus: 8, memoryMb: 64_000, freeDiskMb: 0, load: 0 })).toBe(6);
    // Memory decides when it is the tighter half: four gigabytes is two agents, whatever the core count says.
    expect(runnerSlots({ cpus: 16, memoryMb: 4_096, freeDiskMb: 0, load: 0 })).toBe(2);
    // Never zero, and never past the point where more parallelism stops buying anything.
    expect(runnerSlots({ cpus: 1, memoryMb: 1_024, freeDiskMb: 0, load: 0 })).toBe(1);
    expect(runnerSlots({ cpus: 64, memoryMb: 256_000, freeDiskMb: 0, load: 0 })).toBe(16);
});

test("a sandbox with no runners keeps its work, and says why", () => {
    expect(placeFanOut([], load())).toEqual({ reason: "no-runners" });
});

/* FREE SLOTS DECIDE, NOT LOAD, and this is the case that separates them: a machine already holding four
 * agents can report the same one-minute average as an idle one, because that average is a minute behind. */
test("the machine with the most room wins, even when a busier one looks quieter", () => {
    const placed = placeFanOut([runner("busy", { facts: { cpus: 8, memoryMb: 32_768, freeDiskMb: 0, load: 0.05 } }), runner("free")], load({ busy: 5 }));
    expect(placed).toEqual({ runner: "free", reason: "free-slot" });
});

test("load breaks a tie between equals, and a name breaks a tie between those", () => {
    const quiet = runner("quiet", { facts: { cpus: 8, memoryMb: 32_768, freeDiskMb: 0, load: 0.05 } });
    const noisy = runner("noisy", { facts: { cpus: 8, memoryMb: 32_768, freeDiskMb: 0, load: 0.9 } });
    expect(placeFanOut([noisy, quiet], load()).runner).toBe("quiet");
    // Identical on both counts: a stable order, so a fan-out of eight spreads evenly instead of churning its
    // pick between calls.
    expect(placeFanOut([runner("b"), runner("a")], load()).runner).toBe("a");
});

test("a full fleet falls back here rather than holding the work", () => {
    // Six slots on eight cores, all taken: the sandbox that was free all along is faster than waiting.
    expect(placeFanOut([runner("rig")], load({ rig: 6 }))).toEqual({ reason: "all-busy" });
});

/* USABLE MEANS ONLINE AND MEASURED. A runner that has never connected has told us nothing to size it by, and
 * guessing is how a four-core laptop ends up holding sixteen agents. */
test("offline and never-connected runners are not scheduled onto", () => {
    expect(placeFanOut([runner("asleep", { online: false })], load()).runner).toBeUndefined();
    expect(placeFanOut([{ id: "new", online: true, parity: "unknown" }], load()).runner).toBeUndefined();
});

/* PARITY IS NOT A FILTER. An outdated runner runs turns (§7 of the design), and refusing to schedule onto one
 * would quietly halve a fleet over a version nobody was told mattered. */
test("an outdated runner still takes work", () => {
    expect(placeFanOut([runner("old", { parity: "outdated" })], load()).runner).toBe("old");
});

test("a stated preference wins, and an unusable one falls back rather than failing", () => {
    expect(placeFanOut([runner("a"), runner("b")], load(), { asked: "b" })).toEqual({ runner: "b", reason: "asked-for" });
    // The machine somebody named went to sleep: run it here rather than refuse work over it.
    expect(placeFanOut([runner("a", { online: false })], load(), { asked: "a" })).toEqual({ reason: "all-busy" });
});

/* THE CREDENTIAL RULE. A runner spends the origin's providers only for the Claude Code runtime's family; every
 * other runtime reads a login from the machine it runs on, and a fresh runner has none. Placing there anyway
 * produces a child that dies on its first request and reads as a broken fleet. */
test("a runtime whose credential cannot travel stays here, and one that can still goes", () => {
    expect(credentialsTravel("claude", "native")).toBe(true);
    expect(credentialsTravel("codex", "claude-code")).toBe(true);
    expect(credentialsTravel("endpoint/local", "native")).toBe(true);
    // Native Codex, Cursor and Gemini each authenticate from a CLI's own home on the box that runs them.
    expect(credentialsTravel("codex", "native")).toBe(false);
    expect(credentialsTravel("cursor", "native")).toBe(false);
    expect(credentialsTravel("gemini", "claude-code")).toBe(false);

    expect(placeFanOut([runner("rig")], load(), { travels: false })).toEqual({ reason: "provider-is-local" });
    expect(placeFanOut([runner("rig")], load(), { travels: true }).runner).toBe("rig");
});

// Naming a machine is a person's own claim about their fleet: they may well have signed that provider in
// there, and the scheduler should not argue with it.
test("an explicit machine wins even for a runtime whose credential does not travel", () => {
    expect(placeFanOut([runner("rig")], load(), { asked: "rig", travels: false })).toEqual({ runner: "rig", reason: "asked-for" });
});
