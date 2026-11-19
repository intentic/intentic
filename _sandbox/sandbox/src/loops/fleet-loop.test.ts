import { LoopAskSchema, loopOfAsk } from "./fleet-loop.js";

test("an ask with a check makes fresh rounds that each say how much remains, ended by the check", () => {
    const ask = LoopAskSchema.parse({ prompt: "Take the next open item in BACKLOG.md.", until: "make check", max: 5 });
    expect(loopOfAsk(ask, { conversationId: "rhino-pvf5", isolated: true })).toEqual({
        conversationId: "rhino-pvf5",
        goal: "`make check` exits 0.",
        prompt: "Take the next open item in BACKLOG.md.",
        context: "fresh",
        output: { kind: "claim" },
        checks: [{ kind: "command", command: "make check" }],
        maxIterations: 5,
        stallLimit: 2,
        isolated: true,
    });
});

test("an ask with no check is ended by its rounds' own count, and keeps the limits and routing it names", () => {
    const ask = LoopAskSchema.parse({ prompt: "Next optimization.", spendUsd: 20, provider: "claude", model: "claude-opus-5-5", land: false });
    const loop = loopOfAsk(ask, { conversationId: "rhino-pvf5", isolated: false });
    expect(loop.checks).toEqual([]);
    expect(loop.maxIterations).toBe(10);
    expect(loop).toMatchObject({ maxSpendUsd: 20, agent: "claude", model: "claude-opus-5-5", autoLand: false, isolated: false });
});

test("a model without its provider is refused", () => {
    expect(LoopAskSchema.safeParse({ prompt: "x", model: "claude-opus-5-5" }).success).toBe(false);
});
