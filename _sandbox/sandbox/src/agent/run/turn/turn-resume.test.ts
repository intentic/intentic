import type { HandoffOffer } from "@intentic/sandbox-contract";
import { handoffFor, type HeldTurn } from "./turn-resume.js";

// Which way a spent allowance's held turn continues: the press's word, then the person's pick on the card, then the
// suggestion, and never a way the destination cannot take.

const OFFER: HandoffOffer = {
    suggested: "trim",
    basis: "size",
    carry: { tokens: 420_000 },
    trim: { tokens: 110_000, cleared: 180 },
    summary: { tokens: 40_000, reads: 300_000 },
};

// The press as the editor sends it: the runtime it runs on, and here the same one the turn held.
const HERE = { agent: "claude", harness: "native" } as const;

const held = (over: Partial<HeldTurn> = {}): HeldTurn => ({
    input: { conversationId: "c1", prompt: "Fix the login bug", agent: "claude", harness: "native", account: "acct-1" },
    reason: "limit",
    sessionId: "s-1",
    ran: true,
    handoff: OFFER,
    ...over,
});

describe("handoffFor", () => {
    it("takes the suggestion when nobody picked", () => {
        expect(handoffFor(held(), undefined)).toBe("trim");
    });

    it("takes the person's pick over the suggestion, and the press's word over both", () => {
        const picked = held({ handoff: { ...OFFER, chosen: "carry" } });
        expect(handoffFor(picked, undefined)).toBe("carry");
        expect(handoffFor(picked, { ...HERE, handoff: "summary" })).toBe("summary");
    });

    it("reads an older editor's carry as a pick to carry", () => {
        expect(handoffFor(held(), { ...HERE, carry: true })).toBe("carry");
    });

    it("falls to a summary when the press moves to a runtime holding no session", () => {
        expect(handoffFor(held(), { agent: "codex", harness: "native" })).toBe("summary");
    });

    it("never carries or trims a session the provider never answered in, or one another account refused", () => {
        expect(handoffFor(held({ ran: false }), { ...HERE, handoff: "carry" })).toBe("summary");
        expect(handoffFor(held({ carryRefused: true }), undefined)).toBe("summary");
    });

    it("leaves a hold with no offer, and every other wall, as it always was", () => {
        expect(handoffFor(held({ handoff: undefined }), { ...HERE, handoff: "trim" })).toBeUndefined();
        expect(handoffFor(held({ reason: "outage" }), undefined)).toBeUndefined();
    });

    it("skips a way the offer does not have", () => {
        const { trim: _trim, ...noTrim } = OFFER;
        expect(handoffFor(held({ handoff: noTrim }), { ...HERE, handoff: "trim" })).toBe("summary");
    });
});
