import { expect, test } from "vitest";
import { isAuthFailureText, isFailureSentence, isUsageLimitText, mentionsSpentAllowance } from "./failure-sentences.js";

/* The two conditions the CLI reports as prose, and the third reading of them that the routed providers forced.
 *
 * The prefixes are the SDK's own, so what these pin is the boundary: a sentence the CLI wrote when it stopped
 * trying, versus one it wrote about a spent plan, versus a model's ordinary answer that must never be mistaken
 * for either (isFailureSentence guards the naming paths, where a false positive renames an agent after an error
 * and throws away the prompt it was derived from). */

const KIMI_403 =
    "Failed to authenticate. API Error: 403 You've reached your usage limit for this billing cycle. Your quota will be refreshed in the next cycle.";

test("keeps a refused credential and a spent allowance apart by the prefix each is written with", () => {
    expect(isAuthFailureText("Failed to authenticate. API Error: 401 OAuth access token has been revoked")).toBe(true);
    expect(isUsageLimitText("Failed to authenticate. API Error: 401 OAuth access token has been revoked")).toBe(false);
    expect(isFailureSentence("Sure — I've updated the config and the tests pass.")).toBe(false);
});

/* THE CASE THAT MADE THIS NECESSARY. Kimi answers a spent Kimi Code plan with a 403, and a 403 is what the CLI
 * prints its "Failed to authenticate" prefix over — so the prefix-based classification, which is right about
 * what the CLI has stopped trying, is wrong about what the user must DO. Reading the sentence is what stops the
 * Agent tab from telling someone to reconnect an account in perfect health. */
test("reads a spent plan in a routed provider's own words, whichever prefix the CLI wrote over it", () => {
    expect(isAuthFailureText(KIMI_403)).toBe(true);
    expect(mentionsSpentAllowance(KIMI_403)).toBe(true);
    expect(mentionsSpentAllowance("API Error: 429 quota exceeded for this project")).toBe(true);
});

// A genuinely dead credential says nothing about an allowance, and must keep reading as the reconnect it is.
test("does not read a revoked token as a spent allowance", () => {
    expect(mentionsSpentAllowance("Failed to authenticate. API Error: 401 OAuth access token has been revoked")).toBe(false);
});

/* "rate limit" is deliberately NOT one of the phrases: the harness says it while it is still retrying, and a
 * transient throttle it works through by itself is not a plan that ran out. Pinned because adding the phrase is
 * the obvious-looking change that would quietly start reporting healthy accounts as spent. */
test("ignores the transient throttling the harness retries through by itself", () => {
    expect(mentionsSpentAllowance("API Error: 429 rate limit exceeded, retrying in 620ms")).toBe(false);
});
