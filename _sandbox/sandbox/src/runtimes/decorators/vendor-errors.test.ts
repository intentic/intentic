import { test, expect } from "bun:test";
import { isRateLimited, vendorFailureFrame, type VendorRule, withStderrTail } from "./vendor-errors.js";

/* One classifier for every vendor's spent allowance, the order a runtime's own rules are read in, and stderr folding. */

test("a spent allowance or a rate limit reads as one, in any vendor's words", () => {
    for (const sentence of [
        "429 Too Many Requests",
        "Resource exhausted: retry later",
        "You hit your rate-limit for this model",
        "rate limit reached",
        "You've reached your usage limit for GPT-5",
        "Monthly quota exceeded",
        "Your billing cycle allowance is spent",
    ]) {
        expect(isRateLimited(sentence), sentence).toBe(true);
    }
});

test("an ordinary failure, or a number that merely contains 429, is not a rate limit", () => {
    for (const sentence of ["model not found: grok-9", "4290 tokens were cached", "connection reset by peer", ""]) {
        expect(isRateLimited(sentence), sentence).toBe(false);
    }
});

const RULES: readonly VendorRule[] = [
    [(message) => message.includes("not found"), "grok-model-invalid"],
    [isRateLimited, "rate_limit"],
];

test("the first rule that recognizes the sentence names its code, in the runtime's own order", () => {
    expect(vendorFailureFrame({ kind: "error", message: "model not found (429)" }, RULES)).toEqual({
        kind: "error",
        message: "model not found (429)",
        code: "grok-model-invalid",
    });
    expect(vendorFailureFrame({ kind: "error", message: "model not found (429)" }, RULES.toReversed())).toEqual({
        kind: "error",
        message: "model not found (429)",
        code: "rate_limit",
    });
});

test("a sentence no rule recognizes is the frame it came as, untouched", () => {
    const frame = { kind: "error" as const, message: "the app-server exited" };
    expect(vendorFailureFrame(frame, RULES)).toBe(frame);
});

test("a parameter this sandbox never sends is read before any rule, as the outage it is", () => {
    const refused = "400 invalid_request_error: Unsupported parameter: prompt_cache_retention is not found for this model";
    expect(vendorFailureFrame({ kind: "error", message: refused }, RULES)).toEqual({
        kind: "error",
        code: "provider-outage",
        message: `${refused} This parameter was not sent by intentic. Usually clears on retry; work so far is kept.`,
    });
});

test("stderr joins the sentence it explains, trimmed, and an empty tail adds nothing", () => {
    expect(withStderrTail("Pi exited mid-turn (code 1)", "  boom: missing key\n")).toBe("Pi exited mid-turn (code 1): boom: missing key");
    expect(withStderrTail("Pi exited mid-turn (code 1)", " \n ")).toBe("Pi exited mid-turn (code 1)");
});
