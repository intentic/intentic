import { freshStartLine, freshStartNotice, type HandoffMode, handedOffLine, handedOffNotice, suggestHandoff } from "./handoff.js";

const THRESHOLDS = { carryUnder: 150_000, summaryOver: 700_000 };
const all = (): boolean => true;

describe("suggestHandoff", () => {
    it("carries a small session, trims the middle band, summarises a very large one", () => {
        expect(suggestHandoff(90_000, all, THRESHOLDS)).toBe("carry");
        expect(suggestHandoff(150_000, all, THRESHOLDS)).toBe("trim");
        expect(suggestHandoff(699_999, all, THRESHOLDS)).toBe("trim");
        expect(suggestHandoff(700_000, all, THRESHOLDS)).toBe("summary");
    });

    it("carries when nothing measured the session, since there is no size to save on", () => {
        expect(suggestHandoff(undefined, all, THRESHOLDS)).toBe("carry");
    });

    it("falls to the next way where the preferred one is not available", () => {
        const noTrim = (mode: HandoffMode): boolean => mode !== "trim";
        expect(suggestHandoff(400_000, noTrim, THRESHOLDS)).toBe("summary");
        const carryOnly = (mode: HandoffMode): boolean => mode === "carry";
        expect(suggestHandoff(900_000, carryOnly, THRESHOLDS)).toBe("carry");
        expect(suggestHandoff(900_000, () => false, THRESHOLDS)).toBeUndefined();
    });
});

describe("handedOffLine", () => {
    it("names what the continuing session started from beside what carrying would have re-read", () => {
        expect(handedOffLine({ mode: "trim", tokens: 112_400, from: 431_000, cleared: 180 })).toBe(
            "Continued trimmed to ~112k tokens from 431k: 180 old tool outputs cleared.",
        );
        expect(handedOffLine({ mode: "summary", model: "claude-haiku-5-5", from: 431_000 })).toBe(
            "Continued in a fresh session from a summary by claude-haiku-5-5.",
        );
        expect(handedOffLine({ mode: "carry", tokens: 431_000 })).toBe("Continued in the same session, re-reading ~431k tokens.");
    });

    it("says plainly when the way picked could not be built", () => {
        expect(handedOffLine({ mode: "trim", fellBack: true })).toBe("Couldn't trim the session, so it was carried whole.");
        expect(handedOffNotice({ mode: "summary", fellBack: true })).toStrictEqual({ code: "handedOff", params: { mode: "summary", fellBack: true } });
    });
});

describe("a home's fresh start", () => {
    it("says why the chat started over and what the fresh session opened with", () => {
        expect(freshStartLine({ why: "cold", from: 90_000, summarized: false })).toBe(
            "Idle too long to re-read at ~90k tokens: fresh session, from its recent messages.",
        );
        expect(freshStartLine({ why: "asked", summarized: true })).toBe("Started fresh, as you asked, from a summary.");
        expect(freshStartLine({ why: "cleared", summarized: false })).toBe("History cleared: started fresh, from its recent messages.");
    });

    it("carries only the facts it has", () => {
        expect(freshStartNotice({ why: "asked", summarized: false })).toEqual({ code: "freshStart", params: { why: "asked", summarized: false } });
        expect(freshStartNotice({ why: "budget", from: 151_400, model: "haiku", summarized: true }).params).toEqual({
            why: "budget",
            from: "151k",
            model: "haiku",
            summarized: true,
        });
    });
});


test("a failed summary carries its reason into both the notice and readable line", () => {
    const event = { mode: "summary", fellBack: true, reason: "Every summary model is out of allowance" } as const;
    expect(handedOffNotice(event)).toEqual({ code: "handedOff", params: event });
    expect(handedOffLine(event)).toBe("Couldn't write a summary; started fresh from recent messages. Reason: Every summary model is out of allowance");
});
