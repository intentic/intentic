import { RETRY_HORIZON_S } from "../../../../usage/reset-sentences.js";
import type { ErrorFrame } from "../classify-failure.js";
import { limitCause, limitFrame, saysSpent, throttleAsOutage, throttled } from "./limit-cause.js";
import { SPENT_WORDS, THROTTLE_WORDS } from "./limit-cause.testing.js";

/* ONE DECISION FOR EVERY RUNTIME: A RATE LIMIT IS A SPENT ALLOWANCE ONLY ON EVIDENCE. 2026-11-14 to -19: Google's bare
   RESOURCE_EXHAUSTED, Anthropic's API 429s, Codex's and Cursor's were each coded `rate_limit` and filed on the refusal
   ledger, holding healthy accounts spent until a reading or a turn answered it. Each case below is one kind of evidence,
   in the order the decision reads them. */

const NOW = 1_800_000_000_000;
const NOW_S = NOW / 1000;

describe("the provider's own words", () => {
    test("for a spent allowance decide it, whatever else is said", () => {
        for (const said of Object.values(SPENT_WORDS)) {
            expect(limitCause({ said, now: NOW, gateway: () => "throttled" }), said).toBe("spent");
        }
    });

    test("for requests turned away, with nothing else, are a throttle", () => {
        for (const said of Object.values(THROTTLE_WORDS)) {
            expect(limitCause({ said, now: NOW }), said).toBe("throttle");
        }
    });

    test("naming a reset are a spent allowance only past a retry's horizon, in a JSON body too", () => {
        const body = (seconds: number) => `429 {"error":{"code":"model_cooldown","message":"cooling down","reset_seconds":${seconds}}}`;
        expect(saysSpent(body(RETRY_HORIZON_S + 60), NOW)).toBe(true);
        expect(saysSpent(body(RETRY_HORIZON_S - 60), NOW)).toBe(false);
        expect(saysSpent("Rate limited. Resets in 3h.", NOW)).toBe(true);
        expect(saysSpent("Rate limited. Resets in 30s.", NOW)).toBe(false);
    });

    test("for a key out of credit are no throttle either: a wall of their own, which no wait lifts", () => {
        expect(limitCause({ said: "402 Insufficient Balance", now: NOW })).toBe("spent");
    });

    test("are never the sandbox's own sentence, which says what it was told to", () => {
        const own: ErrorFrame = { kind: "error", code: "rate_limit", message: "Claude usage limit reached. Send again once it resets.", own: true };
        expect(limitFrame(own)).toMatchObject({ code: "provider-outage", throttle: true });
        expect(limitFrame({ ...own, own: undefined })).toMatchObject({ code: "rate_limit" });
    });
});

describe("the translator gateway's verdict on a routed turn", () => {
    test("a throttle it handed back outranks the loop's guess and the records, never the provider's words", () => {
        expect(limitCause({ spent: true, retryAt: NOW_S + 3_600, gateway: () => "throttled", now: NOW })).toBe("throttle");
        expect(limitCause({ said: SPENT_WORDS.google, spent: true, gateway: () => "throttled", now: NOW })).toBe("spent");
    });

    test("a spent allowance it filed is evidence of one", () => {
        expect(limitCause({ said: THROTTLE_WORDS.google, gateway: () => "spent", now: NOW })).toBe("spent");
    });

    test("is asked only where the words have not decided", () => {
        const asked: string[] = [];
        const gateway = () => {
            asked.push("asked");
            return "throttled" as const;
        };
        limitCause({ said: SPENT_WORDS.codex, gateway, now: NOW });
        expect(asked).toEqual([]);
        limitCause({ said: THROTTLE_WORDS.codex, gateway, now: NOW });
        expect(asked).toEqual(["asked"]);
    });
});

describe("structure and instants", () => {
    test("a typed signal that the allowance ran out is a spent allowance", () => {
        expect(limitCause({ said: THROTTLE_WORDS.codex, spent: true, now: NOW })).toBe("spent");
    });

    test("an instant to ask again is a spent allowance only past a retry's horizon", () => {
        expect(limitCause({ retryAt: NOW_S + RETRY_HORIZON_S + 1, now: NOW })).toBe("spent");
        expect(limitCause({ retryAt: NOW_S + RETRY_HORIZON_S, now: NOW })).toBe("throttle");
    });

    test("nothing at all is a throttle: a wording nobody foresaw falls back to what passes, never to a refusal that stands", () => {
        expect(limitCause({ now: NOW })).toBe("throttle");
        expect(limitCause({ said: "429 the provider rephrased everything", now: NOW })).toBe("throttle");
    });
});

describe("a throttle's frame", () => {
    test("is an outage marked `throttle`, without the loop's retry instant, the provider's words read and kept", () => {
        const frame = throttled({ kind: "error", code: "rate_limit", message: `429 {"error":{"code":429,"message":"${THROTTLE_WORDS.google}","status":"RESOURCE_EXHAUSTED"}}`, resetsAt: NOW_S + 30 });
        expect(frame).toMatchObject({ kind: "error", code: "provider-outage", throttle: true });
        expect(frame.resetsAt).toBeUndefined();
        expect(frame.message).toMatch(/^429 Resource has been exhausted \(e\.g\. check quota\)\. \(RESOURCE_EXHAUSTED\)\. The provider is rate-limiting this model for now/u);
    });

    test("replaces the sandbox's own sentence, which said an allowance was spent", () => {
        const frame = throttled({ kind: "error", code: "rate_limit", message: "Gemini usage limit reached. Send again once it resets.", own: true });
        expect(frame.own).toBe(true);
        expect(frame.message).not.toContain("usage limit reached");
    });
});

describe("the door's second reading of a routed turn", () => {
    const routed = { provider: "gemini", model: "gemini-3.8-flash-high", turn: { harness: "opencode" } } as const;
    const limit: ErrorFrame = { kind: "error", code: "rate_limit", message: THROTTLE_WORDS.google };

    test("re-codes a rate limit the gateway handed back as a throttle", () => {
        expect(throttleAsOutage(limit, routed, () => "throttled")).toMatchObject({ code: "provider-outage", throttle: true });
        expect(throttleAsOutage(limit, routed, () => "spent")).toBe(limit);
        // The runtime's call stands where the gateway saw neither.
        expect(throttleAsOutage(limit, routed, () => undefined)).toBe(limit);
    });

    test("leaves a turn held at the door alone: it sent nothing, so no verdict of the gateway's is about it", () => {
        const held: ErrorFrame = { kind: "error", code: "rate_limit", message: "Every Google account is spent.", own: true };
        expect(throttleAsOutage(held, { ...routed, door: true }, () => "throttled")).toBe(held);
    });

    test("leaves a turn on a loop of its own sign-in, and any other code, as it came", () => {
        expect(throttleAsOutage(limit, { provider: "claude", model: "opus", turn: { harness: "claude-code" } }, () => "throttled")).toBe(limit);
        const outage: ErrorFrame = { ...limit, code: "provider-outage" };
        expect(throttleAsOutage(outage, routed, () => "throttled")).toBe(outage);
    });
});
