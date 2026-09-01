import { expect, test } from "vitest";
import {
    isAuthFailureText,
    isDeclinedAnswer,
    isEntitlementRefusalText,
    isFailureSentence,
    isToolCallStandIn,
    isUnsentParameterRefusalText,
    isUsageLimitText,
    mentionsSpentAllowance,
    versionFloorOf,
    withoutToolCallStandIns,
} from "./failure-sentences.js";

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
 * prints its "Failed to authenticate" prefix over, so the prefix-based classification, which is right about
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
 * refuses every turn with a sentence that fits neither predicate above: no usage-limit prefix, and it does not
 * start with "Failed to authenticate", so the frame went out uncoded and nothing durable was ever written about
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

/* A FOURTH READING, AND THE ONE THAT ACTUALLY SHIPPED A BUG. Nothing was wrong with the provider: the naming
 * pass asked a healthy model to name a session, the opening prompt was too thin to name, and the model asked a
 * question back. Every predicate above passed it: it is neither a spent allowance nor a dead credential, so
 * it was written down as the conversation's name at the highest automatic rank, and the commit box then read
 * that name, prefixed it, and filed `feat: i need more context to name this session…` as a commit subject. */
const DECLINED_NAMING = "I need more context to name this session. What feature, surface, file, or system does this touch?";

test("reads a model asking for context as no answer at all: the reply that became a commit subject", () => {
    expect(isDeclinedAnswer(DECLINED_NAMING)).toBe(true);
    // The conditions it is NOT: nothing here is a provider's fault, so nothing here should send the user to an
    // account screen or make them wait for a reset.
    expect(isFailureSentence(DECLINED_NAMING)).toBe(false);
    expect(isEntitlementRefusalText(DECLINED_NAMING)).toBe(false);
});

test("catches the shapes a decline arrives in, not one provider's wording", () => {
    // A question back, whatever it opens with.
    expect(isDeclinedAnswer("Which part of the diff should the subject describe?")).toBe(true);
    // The first person, which a noun-phrase answer never uses.
    expect(isDeclinedAnswer("I'm unable to summarise this change.")).toBe(true);
    expect(isDeclinedAnswer("Sorry, there is not enough here to name.")).toBe(true);
    // And a flat declarative decline, which neither of the two tests above would catch.
    expect(isDeclinedAnswer("Not enough information to write a commit message.")).toBe(true);
    expect(isDeclinedAnswer("Please provide the file contents.")).toBe(true);
});

/* A FIFTH READING, THE 4xx THAT IS NOT THE REQUEST'S FAULT. A ten-minute Codex turn died on `400
 * prompt_cache_retention is not supported on this model`, a parameter no layer in this sandbox sets: the CLI's
 * outgoing body was captured without it, and the provider's own successful answers come back carrying it, so it
 * is the provider's default being refused by the provider. Uncoded, that is a red line and a dead tab over a
 * condition that cleared by itself minutes later. */
const UNSENT_PARAMETER_400 =
    '{"error":{"type":"invalid_request_error","code":"invalid_parameter","message":"prompt_cache_retention is not supported on this model","param":"prompt_cache_retention"}}';

test("reads a refused parameter nothing here sends as the provider's fault, not the turn's", () => {
    expect(isUnsentParameterRefusalText(UNSENT_PARAMETER_400)).toBe(true);
    // Plain prose carries it too: the same refusal reaches the Claude harness as the API error's sentence alone.
    expect(isUnsentParameterRefusalText("API Error: 400 prompt_cache_retention is not supported on this model")).toBe(true);
    // The conditions it must not be confused with: no credential to re-mint, no allowance to wait out.
    expect(isAuthFailureText(UNSENT_PARAMETER_400)).toBe(false);
    expect(mentionsSpentAllowance(UNSENT_PARAMETER_400)).toBe(false);
});

/* BOTH HALVES REQUIRED, which is what keeps this from swallowing ordinary 4xx. A parameter the turn DID ask for
 * (a model, an effort, a tool schema) stays uncoded, because re-sending it on a timer is a loop, and a reply
 * that merely discusses prompt caching, which the CLI's own instructions do, is not a refusal at all. */
test("refuses to read a request's own bad parameter, or a mention of caching, as an outage", () => {
    expect(isUnsentParameterRefusalText("API Error: 400 output_config.effort 'max' is not supported when thinking is disabled")).toBe(false);
    expect(isUnsentParameterRefusalText("Preserve prompt_cache_key when the application already uses it.")).toBe(false);
    expect(isUnsentParameterRefusalText("I set prompt_cache_retention to 24h in the client config.")).toBe(false);
    expect(isUnsentParameterRefusalText("Sure — I've updated the config and the tests pass.")).toBe(false);
});

// The direction that would do real damage: refusing a good answer leaves a session wearing a cut sentence and a
// commit box empty, so every ordinary name and subject has to pass.
test("passes the names and subjects these seams actually exist to collect", () => {
    expect(isDeclinedAnswer("feat: ordered model picker")).toBe(false);
    expect(isDeclinedAnswer("fix: stop the picker reordering on refresh")).toBe(false);
    expect(isDeclinedAnswer("Sandbox freezes · fix")).toBe(false);
    expect(isDeclinedAnswer("Commit message drafting · rethink")).toBe(false);
    expect(isDeclinedAnswer("refactor: drop the title-derived commit subject")).toBe(false);
    // Empty is nothing, not a decline: every caller already treats it as nothing.
    expect(isDeclinedAnswer("")).toBe(false);
    expect(isDeclinedAnswer("   ")).toBe(false);
});

/* THE SIXTH READING, AND THE ONE THAT ARRIVED LOOKING LIKE AN ANSWER: a model writing out the tool call it would
 * have made, because the runtime carrying it (OpenCode, on every Gemini rung) prepends a coding-agent prompt
 * whose worked examples demonstrate exactly that. Four fleet cards and three commits in this repo's own history
 * are named `[tool_call: glob for pattern '**']` and its siblings. */

test("reads a written-out tool call as the non-answer it is", () => {
    expect(isToolCallStandIn("[tool_call: glob for pattern '**']")).toBe(true);
    expect(isToolCallStandIn("[tool_call: ls for path '/work']\n[tool_call: read for absolute_path '/work/a.ts']")).toBe(true);
    expect(isToolCallStandIn('<tool_call>{"name":"Glob"}</tool_call>')).toBe(true);
    expect(isToolCallStandIn("[TOOL_CALLS] search(query='titles')")).toBe(true);
    // The tail of a stand-in line is the model continuing its imagined transcript, so the line goes whole: this
    // one is a title this fleet actually wore.
    expect(isToolCallStandIn("[tool_call: grep for pattern 'gone quiet|offline'] Bluntly search th")).toBe(true);
});

/* Anchored at the start of a line, which is where every runtime that writes these puts them, and that anchor is
 * what keeps the family from swallowing an answer ABOUT one: the commit subject for the change that added this
 * predicate has to be writable. Empty is nothing, not a stand-in, same rule as a decline. */
test("leaves an answer that merely talks about a tool call alone", () => {
    expect(isToolCallStandIn("fix(quick-model): refuse a [tool_call: …] reply as an answer")).toBe(false);
    expect(isToolCallStandIn("Tool-call stand-ins · refuse")).toBe(false);
    expect(isToolCallStandIn("")).toBe(false);
    expect(isToolCallStandIn("   ")).toBe(false);
});

// A model that narrated its tool call and THEN did the job has still done the job: the stand-in lines come off
// and what is left is the reply. Refusing that would spend a rung on the model's phrasing.
test("strips the stand-in lines and keeps whatever the model actually wrote", () => {
    expect(withoutToolCallStandIns("[tool_call: glob for pattern '**']\nSandbox freezes · fix")).toBe("Sandbox freezes · fix");
    expect(withoutToolCallStandIns("Sandbox freezes · fix")).toBe("Sandbox freezes · fix");
    expect(withoutToolCallStandIns("[tool_call: glob for pattern '**']")).toBe("");
});

/* THE FOURTH CONDITION REPORTED AS PROSE, and the first one the sandbox can fix by itself: the provider refuses
 * a model because the engine driving it is too old, and names the version that would work. Both numbers are
 * read out of the sentence because the card turns them into an install (engines/engines.ts); the running one is
 * optional, since only the floor decides which version fixes it. */
const TOO_OLD =
    "API Error: 400 Claude Code 2.1.233 does not support this model; version 2.1.251 or newer is required. Run 'claude update', or update the Claude desktop app, then try again.";

test("reads both versions out of an engine-too-old refusal", () => {
    expect(versionFloorOf(TOO_OLD)).toEqual({ floor: "2.1.251", running: "2.1.233" });
});

// The floor clause is what is matched, not the product name: the rest of the sentence is Anthropic's to reword
// and a classification that broke on a comma would take the recovery down with it.
test("reads the floor even when the sentence is reworded around it", () => {
    expect(versionFloorOf("This model needs a newer client: version 3.0.0 or newer is required.")).toEqual({ floor: "3.0.0" });
});

/* Neighbouring failures must not read as this one. A spent allowance and a refused credential both mention
 * numbers and neither is fixed by installing anything, so a false positive here would answer a billing problem
 * with a download. */
test("does not read other refusals as a version floor", () => {
    expect(versionFloorOf(KIMI_403)).toBeUndefined();
    expect(versionFloorOf("You've hit your session limit · resets 1:40pm (UTC)")).toBeUndefined();
});
