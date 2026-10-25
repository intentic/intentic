import { canonicalProvider, OPENCODE_GEMINI_PROVIDER } from "@intentic/sandbox-contract/models/provider-specs";
import { canonicalRehome, canonicalSpawn, childRouting, sameModel } from "../child-spec.js";
import { loopOf } from "@intentic/sandbox-contract/models/agent-catalog";

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

// The supervisor takes every spawn and move in through these, whichever door it came by, so nothing past it has to know
// that an agent running under OpenCode names Gemini by OpenCode's alias for it.
test("a spawn naming the alias, for itself or a fallback, enters as gemini and runs on its default loop", () => {
    const spec = canonicalSpawn({
        prompt: "explore codebase",
        provider: OPENCODE_GEMINI_PROVIDER,
        model: "gemini-3.8-flash-high",
        fallbacks: [{ provider: OPENCODE_GEMINI_PROVIDER, model: "gemini-2.5-flash" }, { provider: "claude", model: "claude-haiku-4-5" }],
    });
    expect(spec).toEqual({
        prompt: "explore codebase",
        provider: "gemini",
        model: "gemini-3.8-flash-high",
        fallbacks: [{ provider: "gemini", model: "gemini-2.5-flash" }, { provider: "claude", model: "claude-haiku-4-5" }],
    });
    const route = childRouting(spec);
    expect(route).toEqual({ provider: "gemini", harness: "native", model: "gemini-3.8-flash-high" });
    expect(loopOf(route.provider, route.harness)).toBe("opencode");
});

test("a move naming the alias enters as gemini and keeps what else it named", () => {
    expect(canonicalRehome({ provider: OPENCODE_GEMINI_PROVIDER, model: "gemini-3.8-flash-high", effort: "high" })).toEqual({
        provider: "gemini",
        model: "gemini-3.8-flash-high",
        effort: "high",
    });
    expect(canonicalSpawn({ prompt: "p", provider: "codex", model: "gpt-6" })).toEqual({ prompt: "p", provider: "codex", model: "gpt-6" });
});
