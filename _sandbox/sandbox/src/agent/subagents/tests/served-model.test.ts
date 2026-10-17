import { sameModel } from "../child-spec.js";

// 2026-10-17: a Kimi child's re-run ran on kimi-k3 after kimi-k3-256k was taken off the list, and nothing said so. The
// parent is told now, where the served id is another model; an alias the served id spells out is the same one.
test("an alias or a window suffix is the model asked for; a shorter id is another model", () => {
    expect(sameModel("claude-opus-5-5", "opus")).toBe(true);
    expect(sameModel("claude-sonnet-4-6[1m]", "claude-sonnet-4-6")).toBe(true);
    expect(sameModel("kimi-k3", "kimi-k3-256k")).toBe(false);
    expect(sameModel("gpt-6.1-sol", "claude-sonnet-4-6")).toBe(false);
});
