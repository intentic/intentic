import { killSentence } from "../../../system/resources/memory-kill-words.js";
import { type DeathWitness, killCauseOf, killNote, runtimeKilled } from "../child-death.js";

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

// (2026-11-05) A child memory killed is held for the memory release, which sends it again by itself once memory has
// stayed free; its parent sending it the same work meanwhile would run it twice. One whose own process grew is the likely
// cause and waits for a press, so its parent hears not to hand it the same work as it was.
describe("what a parent hears of a child memory killed", () => {
    const failure = "Claude Code process terminated by signal SIGKILL";

    test("that it comes back by itself, where its own frame said the sandbox sends it again", () => {
        const note = killNote("memory", failure, undefined, true);
        expect(note).toContain("sends this turn again by itself once memory has stayed free");
        expect(note).toContain("do not `send` it the same work meanwhile");
        expect(note).not.toContain("`send` it a message");
    });

    test("that it is the likely cause, naming the process, where the process killed was its own", () => {
        const own = { at: 1, killer: "netd-guard", pid: 4242, comm: "cargo", owner: "sub-tidy-pebble-aii1", jobId: "job-7" } as const;
        const note = killNote("memory", failure, own, true);
        // Named in the one sentence the job's ending, the held card and the post-mortem use too.
        expect(note).toContain(`the process killed was its own. ${killSentence(own)}. It is the likely cause`);
        expect(note).toContain("cargo (pid 4242) from background job job-7 of sub-tidy-pebble-aii1 was killed for memory by the sandbox's memory guard");
        expect(note).toContain("not sent again by itself");
        expect(note).not.toContain("once memory has stayed free");
    });

    test("the way back by a message, where nothing brings it back by itself", () => {
        expect(killNote("memory", failure)).toContain("`send` it a message and it carries on from where it stopped, once there is room for it");
        expect(killNote("outside", failure, undefined, true)).toBe(
            `Killed from outside its turn (${failure}). Its session is intact: \`send\` it a message and it carries on from where it stopped.`,
        );
    });
});
