import { AgentEventSchema } from "../events/agent-events.js";
import { TurnEndingSchema } from "../events/transcript.js";
import { AgentPressSchema, NO_PRESS } from "./agent-press.js";
import { AgentSummarySchema } from "./agents.js";

// The card's press (AgentSummary.press) is what every chat window's strip follows over its own reading, so both of its
// kinds, and a hold only a press sends again (`pressOnly`), must survive the wire whole: a key the schema strips is a
// press the window never offers.

describe("AgentPress", () => {
    test("carries nothing to press as itself, not as an absent field", () => {
        expect(AgentPressSchema.parse(NO_PRESS)).toEqual({ kind: "none" });
        const card = AgentSummarySchema.pick({ press: true });
        expect(card.parse({ press: NO_PRESS })).toEqual({ press: { kind: "none" } });
        // An older sandbox says nothing, which is not `none`.
        expect(card.parse({})).toEqual({});
    });

    test.each([
        { reason: "stopped" },
        { reason: "stopped", held: { ran: true, contextTokens: 9_000, pressOnly: true } },
        { reason: "limit", resetsAt: 2_000_000_000, held: { ran: false, handoffTokens: 1_200, moving: "acct-2" }, scheduled: true, nextAt: 2_000_000_100 },
        { reason: "outage" },
        { reason: "flagged", held: { ran: true } },
        { reason: "stopped", held: { ran: true }, retries: { made: 1, max: 3 } },
    ] as const)("round-trips a continue on %o", (ending) => {
        const press = { kind: "continue", ending } as const;
        expect(AgentPressSchema.parse(JSON.parse(JSON.stringify(press)))).toEqual(press);
    });

    test("refuses a kind it does not know, and a continue with no ending", () => {
        expect(AgentPressSchema.safeParse({ kind: "later" }).success).toBe(false);
        expect(AgentPressSchema.safeParse({ kind: "continue" }).success).toBe(false);
    });
});

describe("a hold only a press sends again", () => {
    test("is stated on the record's ending", () => {
        expect(TurnEndingSchema.parse({ reason: "stopped", held: { ran: true, pressOnly: true } }).held).toEqual({ ran: true, pressOnly: true });
    });

    test("is stated on the error frame's held turn", () => {
        const frame = { kind: "error", code: "turn-cap", message: "Reached the maximum number of turns.", autoResume: "available", held: { ran: true, pressOnly: true } };
        expect(AgentEventSchema.parse(frame)).toMatchObject({ kind: "error", held: { ran: true, pressOnly: true } });
    });
});
