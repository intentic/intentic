import { expect, test } from "vitest";
import {
    isAuthFailureText,
    isDeclinedAnswer,
    isEntitlementRefusalText,
    isFailureSentence,
    isSelfIdentityAnswer,
    isToolCallStandIn,
    isUnsentParameterRefusalText,
    isUsageLimitText,
    mentionsSpentAllowance,
    versionFloorOf,
    withoutToolCallStandIns,
} from "./failure-sentences.js";

// Pins the line between each failure condition a routed provider reports as prose and an ordinary model answer;
// isFailureSentence guards the naming paths, where confusing them renames a session after an error or misfires a commit
// subject.

const KIMI_403 =
    "Failed to authenticate. API Error: 403 You've reached your usage limit for this billing cycle. Your quota will be refreshed in the next cycle.";

test("keeps a refused credential and a spent allowance apart by the prefix each is written with", () => {
    expect(isAuthFailureText("Failed to authenticate. API Error: 401 OAuth access token has been revoked")).toBe(true);
    expect(isUsageLimitText("Failed to authenticate. API Error: 401 OAuth access token has been revoked")).toBe(false);
    expect(isFailureSentence("Sure — I've updated the config and the tests pass.")).toBe(false);
});

// Kimi reports a spent plan as a 403, which the CLI's own "Failed to authenticate" prefix also covers; reading the
// sentence is what keeps that from telling someone to reconnect a healthy account.
test("reads a spent plan in a routed provider's own words, whichever prefix the CLI wrote over it", () => {
    expect(isAuthFailureText(KIMI_403)).toBe(true);
    expect(mentionsSpentAllowance(KIMI_403)).toBe(true);
    expect(mentionsSpentAllowance("API Error: 429 quota exceeded for this project")).toBe(true);
});

// A dead credential says nothing about an allowance; it must still read as a reconnect.
test("does not read a revoked token as a spent allowance", () => {
    expect(mentionsSpentAllowance("Failed to authenticate. API Error: 401 OAuth access token has been revoked")).toBe(false);
});

// "rate limit" is deliberately excluded: the harness says it mid-retry, and a throttle it clears on its own is not a
// spent plan. Adding it back would report healthy accounts as spent.
test("ignores the transient throttling the harness retries through by itself", () => {
    expect(mentionsSpentAllowance("API Error: 429 rate limit exceeded, retrying in 620ms")).toBe(false);
});

// A seat with Claude Code disabled fits neither predicate above (no usage-limit prefix, doesn't start with "Failed to
// authenticate"); the account otherwise authenticates fine, so without this the picker kept drawing it as healthy.
const SEAT_REVOKED =
    "Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access";

test("reads a revoked seat as its own condition, not as a spent plan or a dead credential", () => {
    expect(isEntitlementRefusalText(SEAT_REVOKED)).toBe(true);
    // Must not read as either: re-minting a credential or waiting out an allowance would both fail to fix this.
    expect(isAuthFailureText(SEAT_REVOKED)).toBe(false);
    expect(mentionsSpentAllowance(SEAT_REVOKED)).toBe(false);
});

// The reverse matters more: misreading a fixable problem as needing an administrator is the worse mistake.
test("does not read a spent plan or a revoked token as a revoked seat", () => {
    expect(isEntitlementRefusalText(KIMI_403)).toBe(false);
    expect(isEntitlementRefusalText("Failed to authenticate. API Error: 401 OAuth access token has been revoked")).toBe(false);
    expect(isEntitlementRefusalText("Sure — I've updated the config and the tests pass.")).toBe(false);
});

// A healthy model asking for more context passed every predicate above, so it got written down as the session's name
// and then as a commit subject prefixed `feat:`.
const DECLINED_NAMING = "I need more context to name this session. What feature, surface, file, or system does this touch?";

test("reads a model asking for context as no answer at all: the reply that became a commit subject", () => {
    expect(isDeclinedAnswer(DECLINED_NAMING)).toBe(true);
    // Not a provider fault: this should never send the user to an account screen or a reset wait.
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

// A 400 for a parameter nothing in this sandbox sets (the provider's own default, refused by the provider itself) is
// the provider's fault, not the turn's; uncoded it was a dead tab over something that cleared itself minutes later.
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

// Both halves required, or this swallows ordinary 4xx: a parameter the turn actually asked for stays uncoded (retrying
// it is a loop), and text merely discussing caching is not a refusal.
test("refuses to read a request's own bad parameter, or a mention of caching, as an outage", () => {
    expect(isUnsentParameterRefusalText("API Error: 400 output_config.effort 'max' is not supported when thinking is disabled")).toBe(false);
    expect(isUnsentParameterRefusalText("Preserve prompt_cache_key when the application already uses it.")).toBe(false);
    expect(isUnsentParameterRefusalText("I set prompt_cache_retention to 24h in the client config.")).toBe(false);
    expect(isUnsentParameterRefusalText("Sure — I've updated the config and the tests pass.")).toBe(false);
});

// The damaging direction: refusing a good answer leaves a session and a commit box empty.
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

// A model writing out the tool call it would have made, since OpenCode (every Gemini rung) prepends a coding-agent
// prompt whose worked examples demonstrate exactly that.

test("reads a written-out tool call as the non-answer it is", () => {
    expect(isToolCallStandIn("[tool_call: glob for pattern '**']")).toBe(true);
    expect(isToolCallStandIn("[tool_call: ls for path '/work']\n[tool_call: read for absolute_path '/work/a.ts']")).toBe(true);
    expect(isToolCallStandIn('<tool_call>{"name":"Glob"}</tool_call>')).toBe(true);
    expect(isToolCallStandIn("[TOOL_CALLS] search(query='titles')")).toBe(true);
    // The tail of a stand-in line is the model continuing its imagined transcript, so the whole line goes.
    expect(isToolCallStandIn("[tool_call: grep for pattern 'gone quiet|offline'] Bluntly search th")).toBe(true);
});

test("reads a model self-identity reply as a non-answer", () => {
    expect(isSelfIdentityAnswer("Claude Haiku")).toBe(true);
    expect(isSelfIdentityAnswer("claude-haiku-4-5")).toBe(true);
    expect(isSelfIdentityAnswer("I am Claude")).toBe(true);
    expect(isSelfIdentityAnswer("I'm Claude Haiku")).toBe(true);
    expect(isSelfIdentityAnswer("Gemini Flash")).toBe(true);
    expect(isSelfIdentityAnswer("gpt-5.6")).toBe(true);
    expect(isSelfIdentityAnswer("ChatGPT")).toBe(true);
    // Functional names or titles that touch on models must remain valid
    expect(isSelfIdentityAnswer("Model identity · inquire")).toBe(false);
    expect(isSelfIdentityAnswer("Claude model list · update")).toBe(false);
    expect(isSelfIdentityAnswer("Sandbox freezes · fix")).toBe(false);
    expect(isSelfIdentityAnswer("")).toBe(false);
});

// Anchored at line start, where every runtime writes these, so it doesn't swallow an answer merely mentioning one —
// even this predicate's own commit subject must stay writable. Empty is nothing, same rule as a decline.
test("leaves an answer that merely talks about a tool call alone", () => {
    expect(isToolCallStandIn("fix(role-model): refuse a [tool_call: …] reply as an answer")).toBe(false);
    expect(isToolCallStandIn("Tool-call stand-ins · refuse")).toBe(false);
    expect(isToolCallStandIn("")).toBe(false);
    expect(isToolCallStandIn("   ")).toBe(false);
});

// Narrating a tool call then doing the job still counts: only the stand-in lines come off.
test("strips the stand-in lines and keeps whatever the model actually wrote", () => {
    expect(withoutToolCallStandIns("[tool_call: glob for pattern '**']\nSandbox freezes · fix")).toBe("Sandbox freezes · fix");
    expect(withoutToolCallStandIns("Sandbox freezes · fix")).toBe("Sandbox freezes · fix");
    expect(withoutToolCallStandIns("[tool_call: glob for pattern '**']")).toBe("");
});

// An engine-too-old refusal, the first condition this sandbox can fix itself. Both versions are read out since the card
// turns them into an install (engines/engines.ts); the running one is optional, since only the floor decides the fix.
const TOO_OLD =
    "API Error: 400 Claude Code 2.1.233 does not support this model; version 2.1.251 or newer is required. Run 'claude update', or update the Claude desktop app, then try again.";

test("reads both versions out of an engine-too-old refusal", () => {
    expect(versionFloorOf(TOO_OLD)).toEqual({ floor: "2.1.251", running: "2.1.233" });
});

// Matches the floor clause, not the product name, which is Anthropic's to reword freely.
test("reads the floor even when the sentence is reworded around it", () => {
    expect(versionFloorOf("This model needs a newer client: version 3.0.0 or newer is required.")).toEqual({ floor: "3.0.0" });
});

// A spent allowance or a refused credential both mention numbers but neither is fixed by installing anything; a false
// positive here would answer a billing problem with a download.
test("does not read other refusals as a version floor", () => {
    expect(versionFloorOf(KIMI_403)).toBeUndefined();
    expect(versionFloorOf("You've hit your session limit · resets 1:40pm (UTC)")).toBeUndefined();
});
