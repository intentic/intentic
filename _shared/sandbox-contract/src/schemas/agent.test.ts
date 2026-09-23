import { describe, expect, test } from "bun:test";
import { AgentTurnSchema, profileOf, TurnProfileSchema } from "./agent.js";

// The profile is what every continuation carries whole, so its field set and its normalisation are the contract: a key
// dropped here is a knob every resume, wake and nudge silently resets.
describe("TurnProfile", () => {
    test("names exactly the fields that say which turn this is", () => {
        expect(Object.keys(TurnProfileSchema.shape).toSorted()).toEqual([
            "account",
            "actsAs",
            "agent",
            "effort",
            "fast",
            "harness",
            "isolated",
            "model",
            "runRole",
            "thinking",
            "unattended",
        ]);
    });

    test("takes every stated field off a turn, and nothing it says or where it goes", () => {
        const turn = AgentTurnSchema.parse({
            prompt: "Fix the login bug",
            conversationId: "c-1",
            sessionId: "s-1",
            agent: "codex",
            harness: "claude-code",
            account: "acct-2",
            model: "gpt-5",
            effort: "high",
            thinking: false,
            fast: true,
            actsAs: "support",
            isolated: true,
            unattended: true,
            runRole: "loop-iteration",
            permissionMode: "plan",
            autoLand: false,
        });
        expect(profileOf(turn)).toStrictEqual({
            agent: "codex",
            harness: "claude-code",
            account: "acct-2",
            model: "gpt-5",
            effort: "high",
            thinking: false,
            fast: true,
            actsAs: "support",
            isolated: true,
            unattended: true,
            runRole: "loop-iteration",
        });
    });

    test("leaves absent fields absent rather than naming them undefined", () => {
        expect(profileOf({ model: "sonnet", effort: undefined })).toStrictEqual({ model: "sonnet" });
        expect(Object.keys(profileOf({}))).toEqual([]);
    });

    // `thinking: false` is a choice the next turn must keep; `isolated: false` only restates the default.
    test("carries a false knob but not a false placement or audience", () => {
        expect(profileOf({ thinking: false, fast: false, isolated: false, unattended: false })).toStrictEqual({ thinking: false, fast: false });
    });
});
