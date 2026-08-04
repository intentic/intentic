import { expect, test } from "vitest";
import { isAuthFailureText, isEntitlementRefusalText, isFailureSentence, isUsageLimitText, mentionsSpentAllowance } from "./failure-sentences.js";

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

/* THE THIRD CONDITION, AND WHY IT NEEDED ONE. An organization that has switched Claude Code off for a seat
 * refuses every turn with a sentence that fits neither predicate above — no usage-limit prefix, and it does not
 * start with "Failed to authenticate" — so the frame went out uncoded and nothing durable was ever written about
 * it. The account meanwhile authenticates fine and its usage endpoint keeps publishing pools, so the picker went
 * on drawing a full, fresh ring over the one account in the list that could not run anything at all. */
const SEAT_REVOKED =
    "Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access";

test("reads a revoked seat as its own condition, not as a spent plan or a dead credential", () => {
    expect(isEntitlementRefusalText(SEAT_REVOKED)).toBe(true);
    // The two it must not be mistaken for: a re-mint and a reset are both recoveries that cannot help here, and
    // offering either sends the user somewhere that will not fix it.
    expect(isAuthFailureText(SEAT_REVOKED)).toBe(false);
    expect(mentionsSpentAllowance(SEAT_REVOKED)).toBe(false);
});

// And the reverse, which is the direction that would do real damage: a spent plan or a revoked token read as an
// entitlement problem would tell the user to go and find an administrator over something they can fix themselves.
test("does not read a spent plan or a revoked token as a revoked seat", () => {
    expect(isEntitlementRefusalText(KIMI_403)).toBe(false);
    expect(isEntitlementRefusalText("Failed to authenticate. API Error: 401 OAuth access token has been revoked")).toBe(false);
    expect(isEntitlementRefusalText("Sure — I've updated the config and the tests pass.")).toBe(false);
});
