import { canonicalProvider, childRouting, sameModel } from "../child-spec.js";
import { loopOf } from "@intentic/sandbox-contract/models/agent-catalog";
import { OPENCODE_GEMINI_PROVIDER } from "../../../runtimes/gemini/gemini-models.js";

// 2026-10-17: a Kimi child's re-run ran on kimi-k3 after kimi-k3-256k was taken off the list, and nothing said so. The
// parent is told now, where the served id is another model; an alias the served id spells out is the same one.
test("an alias or a window suffix is the model asked for; a shorter id is another model", () => {
    expect(sameModel("claude-opus-5-5", "opus")).toBe(true);
    expect(sameModel("claude-sonnet-4-6[1m]", "claude-sonnet-4-6")).toBe(true);
    expect(sameModel("kimi-k3", "kimi-k3-256k")).toBe(false);
    expect(sameModel("gpt-6.1-sol", "claude-sonnet-4-6")).toBe(false);
});

test("canonicalProvider maps OpenCode's gemini runtime alias to canonical gemini", () => {
    expect(canonicalProvider(OPENCODE_GEMINI_PROVIDER)).toBe("gemini");
    expect(canonicalProvider("claude")).toBe("claude");
});

test("childRouting resolves intentic-gemini to gemini and selects the default loop", () => {
    const route = childRouting({ prompt: "explore codebase", provider: OPENCODE_GEMINI_PROVIDER, model: "gemini-3.8-flash-high" });
    expect(route).toEqual({
        provider: "gemini",
        harness: "native",
        model: "gemini-3.8-flash-high",
    });
    expect(loopOf(route.provider, route.harness)).toBe("opencode");
});
