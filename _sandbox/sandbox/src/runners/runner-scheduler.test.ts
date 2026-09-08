import type { RunnerSummary } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { credentialsTravel, placeFanOut, runnerSlots } from "./runner-scheduler.js";

// Where a spawned agent lands when nobody chose: run per fan-out member, so a wrong rule piles a whole fleet onto one
// machine while others idle.

const runner = (id: string, overrides: Partial<RunnerSummary> = {}): RunnerSummary => ({
    id,
    online: true,
    parity: "current",
    facts: { cpus: 8, memoryMb: 32_768, freeDiskMb: 100_000, load: 0.1 },
    ...overrides,
});

const load = (counts: Record<string, number> = {}) => ({ inFlight: new Map(Object.entries(counts)) });

test("slots are the lower of what the cores and the memory can hold", () => {
    // Cores minus 2: the reserve covers the daemon and whoever else uses that machine.
    expect(runnerSlots({ cpus: 8, memoryMb: 64_000, freeDiskMb: 0, load: 0 })).toBe(6);
    // Memory wins when it's the tighter constraint: 4GB is 2 agents, regardless of core count.
    expect(runnerSlots({ cpus: 16, memoryMb: 4_096, freeDiskMb: 0, load: 0 })).toBe(2);
    // Floors at 1 and caps at 16: more parallelism past that stops paying off.
    expect(runnerSlots({ cpus: 1, memoryMb: 1_024, freeDiskMb: 0, load: 0 })).toBe(1);
    expect(runnerSlots({ cpus: 64, memoryMb: 256_000, freeDiskMb: 0, load: 0 })).toBe(16);
});

test("a sandbox with no runners keeps its work, and says why", () => {
    expect(placeFanOut([], load())).toEqual({ reason: "no-runners" });
});

// A busy machine can show the same one-minute load average as an idle one, since that average lags behind.
test("the machine with the most room wins, even when a busier one looks quieter", () => {
    const placed = placeFanOut([runner("busy", { facts: { cpus: 8, memoryMb: 32_768, freeDiskMb: 0, load: 0.05 } }), runner("free")], load({ busy: 5 }));
    expect(placed).toEqual({ runner: "free", reason: "free-slot" });
});

test("load breaks a tie between equals, and a name breaks a tie between those", () => {
    const quiet = runner("quiet", { facts: { cpus: 8, memoryMb: 32_768, freeDiskMb: 0, load: 0.05 } });
    const noisy = runner("noisy", { facts: { cpus: 8, memoryMb: 32_768, freeDiskMb: 0, load: 0.9 } });
    expect(placeFanOut([noisy, quiet], load()).runner).toBe("quiet");
    // Identical on every count: a stable order keeps an eight-way fan-out from churning its pick between calls.
    expect(placeFanOut([runner("b"), runner("a")], load()).runner).toBe("a");
});

test("a full fleet falls back here rather than holding the work", () => {
    // Six slots on eight cores, all six taken: this sandbox has been full the whole time.
    expect(placeFanOut([runner("rig")], load({ rig: 6 }))).toEqual({ reason: "all-busy" });
});

// Usable means online and measured; a runner that never connected has nothing to size it by.
test("offline and never-connected runners are not scheduled onto", () => {
    expect(placeFanOut([runner("asleep", { online: false })], load()).runner).toBeUndefined();
    expect(placeFanOut([{ id: "new", online: true, parity: "unknown" }], load()).runner).toBeUndefined();
});

// Parity is reported, not enforced: an outdated runner still takes work rather than being filtered out.
test("an outdated runner still takes work", () => {
    expect(placeFanOut([runner("old", { parity: "outdated" })], load()).runner).toBe("old");
});

test("a stated preference wins, and an unusable one falls back rather than failing", () => {
    expect(placeFanOut([runner("a"), runner("b")], load(), { asked: "b" })).toEqual({ runner: "b", reason: "asked-for" });
    expect(placeFanOut([runner("a", { online: false })], load(), { asked: "a" })).toEqual({ reason: "all-busy" });
});

// A runner only spends the origin's providers for the Claude Code runtime family; every other runtime reads its own
// login from the machine it runs on, which a fresh runner lacks.
test("a runtime whose credential cannot travel stays here, and one that can still goes", () => {
    expect(credentialsTravel("claude", "native")).toBe(true);
    expect(credentialsTravel("codex", "claude-code")).toBe(true);
    expect(credentialsTravel("endpoint/local", "native")).toBe(true);
    // Native Codex, Cursor and Gemini each authenticate from a CLI's own home on the box running them.
    expect(credentialsTravel("codex", "native")).toBe(false);
    expect(credentialsTravel("cursor", "native")).toBe(false);
    expect(credentialsTravel("gemini", "claude-code")).toBe(false);

    expect(placeFanOut([runner("rig")], load(), { travels: false })).toEqual({ reason: "provider-is-local" });
    expect(placeFanOut([runner("rig")], load(), { travels: true }).runner).toBe("rig");
});

// Naming a machine is the owner's own claim about their fleet; the scheduler should not second-guess it.
test("an explicit machine wins even for a runtime whose credential does not travel", () => {
    expect(placeFanOut([runner("rig")], load(), { asked: "rig", travels: false })).toEqual({ runner: "rig", reason: "asked-for" });
});
