import type { Loop, LoopIteration } from "@intentic/sandbox-contract/schemas/loops";
import { briefForIteration } from "./loop-brief.js";

const loop: Loop = {
    conversationId: "loop-1",
    goal: "No unfinished item is left in OPTIMIZATIONS.md.",
    prompt: "Take the next unfinished item in OPTIMIZATIONS.md and finish it.",
    context: "fresh",
    output: { kind: "claim" },
    checks: [],
    maxIterations: 10,
    stallLimit: 2,
    isolated: true,
};

test("a round is asked to count what remains, and told that zero ends the job", () => {
    const brief = briefForIteration(loop, 1);
    expect(brief).toContain(`"remaining"`);
    expect(brief).toContain("Zero ends the job");
    expect(brief).not.toContain("Where the last round left it");
});

test("a round is handed where the one before it ended, so it need not re-read the history to learn it", () => {
    const previous: LoopIteration = { n: 3, at: 1, outcome: "continue", changed: true, detail: "Group 7 landed; groups 8-11 are open.", remaining: 4 };
    const brief = briefForIteration(loop, 4, previous);
    expect(brief).toContain("## Where the last round left it");
    expect(brief).toContain("> Group 7 landed; groups 8-11 are open.");
    expect(brief).toContain("It counted 4 still open.");
});
