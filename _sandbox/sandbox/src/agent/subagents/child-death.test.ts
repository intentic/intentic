import type { MemoryHeadroom } from "../../platform/resources/memory-admission.js";
import { killCauseOf, runtimeKilled } from "./child-death.js";

const GIB = 1024 ** 3;

const reading = (freeGib: number, oomKills: number | undefined): MemoryHeadroom => ({
    limitBytes: 16 * GIB,
    usedBytes: (16 - freeGib) * GIB,
    swapBytes: 0,
    freeBytes: freeGib * GIB,
    stalledPercent: 0,
    oomKills,
});

test("the SDK's sentences for a runtime killed by signal read as a kill, with its stderr tail after them", () => {
    expect(runtimeKilled("Claude Code process exited with code 137")).toBe(true);
    expect(runtimeKilled("Claude Code process exited with code 143\nstderr: …")).toBe(true);
    expect(runtimeKilled("Claude Code process terminated by signal SIGKILL")).toBe(true);
    expect(runtimeKilled("Claude Code process terminated by signal SIGTERM")).toBe(true);
});

test("a runtime that exited on its own, or a provider's refusal, is the child's own failure", () => {
    expect(runtimeKilled("Claude Code process exited with code 1")).toBe(false);
    expect(runtimeKilled("Claude Code process exited with code 1370")).toBe(false);
    expect(runtimeKilled("Claude Code process terminated by signal SIGINT")).toBe(false);
    expect(runtimeKilled("API Error: 500 Internal server error")).toBe(false);
});

test("the OOM killer moving during the turn names memory, even once the box has room again", () => {
    expect(killCauseOf(reading(8, 4), 3)).toBe("memory");
});

// earlyoom and the host's own killer act from userspace, so the counter never moves: the box being short is the evidence.
test("a box short now names memory with the counter still", () => {
    expect(killCauseOf(reading(1, 3), 3)).toBe("memory");
    expect(killCauseOf(reading(1, undefined), undefined)).toBe("memory");
});

test("a steady counter on a box with room names something outside the turn", () => {
    expect(killCauseOf(reading(8, 3), 3)).toBe("outside");
    // No count at the start (no cgroup then) cannot prove the killer moved.
    expect(killCauseOf(reading(8, 9), undefined)).toBe("outside");
});
