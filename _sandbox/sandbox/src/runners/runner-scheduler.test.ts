import { credentialsTravel, runnerSlots } from "./runner-scheduler.js";

// The two facts every placement starts from. Which machine wins is fleet-advice.test.ts and child-placement.test.ts.

test("slots are the lower of what the cores and the memory can hold", () => {
    // Cores minus 2: the reserve covers the daemon and whoever else uses that machine.
    expect(runnerSlots({ cpus: 8, memoryMb: 64_000, freeDiskMb: 0, load: 0 })).toBe(6);
    // Memory wins when it's the tighter constraint: 4 GiB is 4 agents at the gibibyte each one holds here.
    expect(runnerSlots({ cpus: 16, memoryMb: 4_096, freeDiskMb: 0, load: 0 })).toBe(4);
    expect(runnerSlots({ cpus: 16, memoryMb: 4_095, freeDiskMb: 0, load: 0 })).toBe(3);
    // Floors at 1 and caps at 16: more parallelism past that stops paying off.
    expect(runnerSlots({ cpus: 1, memoryMb: 1_024, freeDiskMb: 0, load: 0 })).toBe(1);
    expect(runnerSlots({ cpus: 64, memoryMb: 256_000, freeDiskMb: 0, load: 0 })).toBe(16);
});

// A runner only spends the origin's providers for the Claude Code runtime family; every other runtime reads its own
// login from the machine it runs on, which a fresh runner lacks.
test("only the Claude Code runtime family's sign-in travels", () => {
    expect(credentialsTravel("claude", "native")).toBe(true);
    expect(credentialsTravel("codex", "claude-code")).toBe(true);
    expect(credentialsTravel("endpoint/local", "native")).toBe(true);
    // Native Codex, Cursor and Gemini each authenticate from a CLI's own home on the box running them.
    expect(credentialsTravel("codex", "native")).toBe(false);
    expect(credentialsTravel("cursor", "native")).toBe(false);
    expect(credentialsTravel("gemini", "claude-code")).toBe(false);
});
