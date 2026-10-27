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
            "Continued in a trimmed copy of the session (about 112k tokens instead of 431k): 180 older tool outputs cleared, every message and tool call kept.",
        );
        expect(handedOffLine({ mode: "summary", model: "claude-haiku-5-5", from: 431_000 })).toBe(
            "Continued in a fresh session opened with a summary of the conversation written by claude-haiku-5-5.",
        );
        expect(handedOffLine({ mode: "carry", tokens: 431_000 })).toBe("Continued in the same session, re-reading all of it (about 431k tokens).");
    });

    it("says plainly when the way picked could not be built", () => {
        expect(handedOffLine({ mode: "trim", fellBack: true })).toBe("Could not trim the session for the hand-off, so it was carried whole.");
        expect(handedOffNotice({ mode: "summary", fellBack: true })).toStrictEqual({ code: "handedOff", params: { mode: "summary", fellBack: true } });
    });
});

describe("a home's fresh start", () => {
    it("says why the chat started over and what the fresh session opened with", () => {
        expect(freshStartLine({ why: "cold", from: 90_000, summarized: false })).toBe(
            "This chat had been idle long enough that re-reading it at about 90k tokens would cost more than starting over, so it went on in a fresh session, opened with its latest messages and the work in hand.",
        );
        expect(freshStartLine({ why: "asked", summarized: true })).toBe(
            "Started fresh, as you asked, opened with a summary of the conversation and its latest messages.",
        );
        expect(freshStartLine({ why: "cleared", summarized: false })).toBe("History cleared: started fresh, opened with its latest messages and the work in hand.");
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
