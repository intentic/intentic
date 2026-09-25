import { type DeathWitness, killCauseOf, runtimeKilled } from "./child-death.js";

// What the budget saw: the OOM count now, and whether a reading in the last few minutes was short.
const witness = (shortRecently: boolean, oomKills: number | undefined): DeathWitness => ({ oomKills, shortRecently });

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
    expect(killCauseOf(witness(false, 4), 3)).toBe("memory");
});

// earlyoom and the host's own killer act from userspace, so the counter never moves: the box having been short is the
// evidence, read off the budget's own recent readings rather than a verdict taken after the death.
test("a box the sampler saw short names memory with the counter still", () => {
    expect(killCauseOf(witness(true, 3), 3)).toBe("memory");
    expect(killCauseOf(witness(true, undefined), undefined)).toBe("memory");
});

test("a steady counter on a box with room names something outside the turn", () => {
    expect(killCauseOf(witness(false, 3), 3)).toBe("outside");
    // No count at the start (no cgroup then) cannot prove the killer moved.
    expect(killCauseOf(witness(false, 9), undefined)).toBe("outside");
});
