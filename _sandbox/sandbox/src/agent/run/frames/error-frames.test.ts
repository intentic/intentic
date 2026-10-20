import type { AgentErrorCode } from "@intentic/sandbox-contract/events/agent-events";
import { isRateLimited } from "../../../engines/failure-sentences.js";
import { codedFailure, type FailureRule } from "./error-frames.js";

/* ONE READING OF A FAILURE'S WORDS, FOR EVERY RUNTIME. Each loop used to read its vendor's sentences with its own list,
   and several read none (a thrown frame, Cursor, Muse's, a decorator's), so the same provider sentence was a held spent
   allowance on one loop and a dead turn re-run into the same wall on another. The door every runtime's frames go out by
   reads them all with this. The words below are real ones, taken from this sandbox's transcripts (2026-10-20). */

// What the door codes, whichever loop said it.
const CODED: readonly (readonly [string, AgentErrorCode])[] = [
    ["Resource has been exhausted (e.g. check quota).", "rate_limit"],
    ["exceeded retry limit, last status: 429 Too Many Requests", "rate_limit"],
    ["Increase limits for faster responses You're out of usage. Switch to Auto or Composer 2.5, or ask your admin to increase your limit to continue.", "rate_limit"],
    ["You’ve hit your usage limit. To get more access now, send a request to your admin or try again at 4:11 PM.", "rate_limit"],
    ["Your team has reached its usage limit Click Continue to enable on-demand usage", "rate_limit"],
    ["Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 65h4m34s.", "rate_limit"],
    ["You've reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends.", "rate_limit"],
    ["Failed to authenticate. API Error: 403 You've reached your weekly (7-day) usage limit. Your quota will reset when the current 7-day window ends.", "rate_limit"],
    ["All credentials for model claude-opus-4-6-thinking are cooling down via provider antigravity", "rate_limit"],
    ["prompt is too long: maximum context length is 200000 tokens", "context-overflow"],
    ["400 invalid_request_error: Unsupported parameter: prompt_cache_retention is not found for this model", "provider-outage"],
];

// What the door leaves unnamed: the harness or the sandbox itself breaking, or a provider's words only its own loop can
// read by type (a Claude 401, Cursor's role_forbidden, a 500 the CLI categorised). Unnamed is a kind of its own: the chat
// says so and keeps the words behind a press (failureView.ts), and the daemon re-runs it on the stop ladder.
const UNNAMED: readonly string[] = [
    "No capacity available for model claude-opus-4-6-thinking on the server",
    "unexpected status 503 Service Unavailable: auth_unavailable: no auth available (providers=codex, model=gpt-5.6-sol)",
    "Claude Code process exited with code 143. stderr: Ignoring 13 permissions.allow entries from .claude/settings.json",
    "Claude Code process terminated by signal SIGKILL",
    "stdout maxBuffer length exceeded",
    "fetch failed",
    "EEXIST: file already exists, open '/tmp/intentic-browser-mcp-YrSb9o/identity-43815.json'",
    "stream disconnected before completion: error sending request for url (http://127.0.0.1:8789/v1/responses)",
    "Failed to authenticate. API Error: 401 OAuth access token has been revoked.",
    "[role_forbidden] Cloud Agent is not available for non-billable admins.",
    "API Error: 500 Internal server error. This is a server-side issue, usually temporary — try again in a moment.",
];

test("every runtime's words for a spent allowance, a window outgrown or an unsent parameter are coded at the door", () => {
    expect(CODED.map(([message]) => `${message} → ${codedFailure({ kind: "error", message }).code}`)).toEqual(CODED.map(([message, code]) => `${message} → ${code}`));
});

test("words nothing names stay unnamed, rather than guessed into a code they are not", () => {
    expect(UNNAMED.map((message) => codedFailure({ kind: "error", message }).code)).toEqual(UNNAMED.map(() => undefined));
});

test("a frame its loop coded, or the sandbox worded, comes back as it is", () => {
    const typed = { kind: "error" as const, code: "provider-outage" as const, message: "429 Too Many Requests" };
    const worded = { kind: "error" as const, message: "Pi timed out: nothing for 2m. Its usage limit was never reached.", own: true };
    expect(codedFailure(typed)).toBe(typed);
    expect(codedFailure(worded)).toBe(worded);
});

test("a spent allowance or a rate limit reads as one, in any vendor's words; a number that merely holds 429 does not", () => {
    for (const sentence of ["429 Too Many Requests", "Resource exhausted: retry later", "You hit your rate-limit for this model", "Monthly quota exceeded"]) {
        expect(isRateLimited(sentence), sentence).toBe(true);
    }
    for (const sentence of ["model not found: grok-9", "4290 tokens were cached", "connection reset by peer", ""]) {
        expect(isRateLimited(sentence), sentence).toBe(false);
    }
});

test("a runtime's own rules are read before the shared ones, and an unsent parameter before both", () => {
    const own: readonly FailureRule[] = [[(message) => message.includes("not found"), "grok-model-invalid"]];
    expect(codedFailure({ kind: "error", message: "model not found (429)" }, own).code).toBe("grok-model-invalid");
    expect(codedFailure({ kind: "error", message: "model not found (429)" }).code).toBe("rate_limit");
    const refused = "400 invalid_request_error: Unsupported parameter: prompt_cache_retention is not found for this model";
    expect(codedFailure({ kind: "error", message: refused }, own)).toEqual({
        kind: "error",
        code: "provider-outage",
        message: `${refused} This parameter was not sent by intentic. Usually clears on retry; work so far is kept.`,
    });
});
