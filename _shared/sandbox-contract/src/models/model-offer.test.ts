import { test, expect } from "bun:test";
import { type ModelOffer, offerLines, parseModelPick, renewsInWords } from "./model-offer.js";

/* THE OFFER the Auto judge chooses from, and the reading of what it replies. Pure both ways: no catalog, no account. */

const NOW = 1_700_000_000_000;
// Epoch SECONDS, as every reset instant on this wire; two hours past `NOW`.
const IN_TWO_HOURS = Math.floor(NOW / 1000) + 2 * 3600;

const OFFER: ModelOffer = {
    models: [
        { provider: "claude", model: "claude-opus-5", label: "Opus 5", efforts: ["low", "medium", "high", "max"], note: "Deep reasoning." },
        { provider: "claude", model: "claude-haiku-4-5", label: "Haiku 4.5", efforts: ["low", "medium"] },
        { provider: "codex", model: "gpt-5", label: "GPT-5", efforts: [] },
    ],
    accounts: {
        claude: [
            {
                id: "work",
                label: "work@studio",
                windows: [
                    { short: "5h", left: 38, resetsAt: IN_TWO_HOURS },
                    { short: "wk", left: 61 },
                ],
            },
            { id: "personal", windows: [] },
        ],
        codex: [],
    },
};

test("a model line carries what it is, what it is for, and the efforts it takes", () => {
    const lines = offerLines(OFFER, NOW);
    expect(lines).toContain("- claude:claude-opus-5 — Opus 5. Deep reasoning. Effort: low, medium, high, max.");
    // No note, so nothing is invented to fill the gap.
    expect(lines).toContain("- claude:claude-haiku-4-5 — Haiku 4.5. Effort: low, medium.");
    // A model that takes no effort setting says nothing about effort rather than offering an empty ladder.
    expect(lines).toContain("- codex:gpt-5 — GPT-5.");
});

test("an account line says what is LEFT, names its pool and when it renews", () => {
    const lines = offerLines(OFFER, NOW);
    expect(lines).toContain("  - work (work@studio) — 5h: 38% left (renews in about 2h), wk: 61% left");
    // Never measured is its own answer: reading it as empty would bench an account that may be entirely free.
    expect(lines).toContain("  - personal — allowance never measured");
});

test("a provider with no named account still offers its models, and says why no account is named", () => {
    expect(offerLines(OFFER, NOW)).toContain("- codex: no named account; this provider resolves its own.");
});

test("resets are phrased relatively, and coarsely at every scale", () => {
    const seconds = Math.floor(NOW / 1000);
    expect(renewsInWords(seconds + 30, NOW)).toBe("any moment");
    expect(renewsInWords(seconds + 25 * 60, NOW)).toBe("in about 25 min");
    expect(renewsInWords(seconds + 5 * 3600, NOW)).toBe("in about 5h");
    expect(renewsInWords(seconds + 4 * 86_400, NOW)).toBe("in about 4 days");
});

test("the three keyed lines are read back against the offer", () => {
    expect(parseModelPick("model: claude:claude-opus-5\neffort: high\naccount: work", OFFER).pick).toEqual({
        provider: "claude",
        model: "claude-opus-5",
        effort: "high",
        account: "work",
    });
});

test("a reply is read through the wrappers a model reaches for anyway", () => {
    const wrapped = "```\n- model: `claude:claude-haiku-4-5`\n- Effort: LOW\n```";
    expect(parseModelPick(wrapped, OFFER).pick).toEqual({ provider: "claude", model: "claude-haiku-4-5", effort: "low" });
});

test("the first answer wins: a later line is commentary, not a second choice", () => {
    const twice = "model: claude:claude-haiku-4-5\nmodel: claude:claude-opus-5";
    expect(parseModelPick(twice, OFFER).pick?.model).toBe("claude-haiku-4-5");
});

test("a model that is not on the list yields no pick at all, carrying what it said", () => {
    // The load-bearing choice: the caller steps to the next rung rather than running an id no provider has.
    expect(parseModelPick("model: claude:claude-sonnet-9", OFFER)).toEqual({ pick: undefined, token: "claude:claude-sonnet-9" });
    expect(parseModelPick("Opus, obviously", OFFER)).toEqual({ pick: undefined, token: "" });
});

test("an unrecognised effort or account is dropped, and the model it came with is kept", () => {
    // Refinements, not the choice: the turn's own defaults answer for them, and losing a whole rung over one would
    // spend another reading to learn nothing.
    const offEffort = parseModelPick("model: claude:claude-haiku-4-5\neffort: max\naccount: nobody", OFFER);
    expect(offEffort.pick).toEqual({ provider: "claude", model: "claude-haiku-4-5" });
});

test("an account of another provider is not honoured under this one", () => {
    // `work` is a Claude account; naming it under codex would spend a credential that provider has no idea about.
    expect(parseModelPick("model: codex:gpt-5\naccount: work", OFFER).pick).toEqual({ provider: "codex", model: "gpt-5" });
});
