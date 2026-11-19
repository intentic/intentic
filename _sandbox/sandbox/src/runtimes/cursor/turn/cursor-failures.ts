import type { RunError } from "@cursor/sdk";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { z } from "zod";
import { isRateLimited } from "../../../engines/failure-sentences.js";
import { limitFrame } from "../../../agent/run/frames/limits/limit-cause.js";

// How Cursor's own failures are coded for the daemon: an account the server refuses outright, and a run that ended on a
// spent plan. Read beside the SDK's error classes (cursor-agent.ts codedError), which say neither.

// The server's codes for an account it will not serve at all, whatever the model: the account signs in, and its role or
// plan has no access (`[role_forbidden] Cloud Agent is not available for non-billable admins.`, a 403 the SDK files under
// its generic class with `isRetryable: false`). "Cloud Agent" is the server's name for the API the local agent rides
// too, not a cloud route this daemon took.
const ACCOUNT_REFUSED_CODES: ReadonlySet<string> = new Set(["role_forbidden"]);

// The SDK formats a server error as `[code] message`; the bracket is the half that survives where the code field does
// not (a run's terminal error carries only the sentence on some paths).
const bracketCode = (message: string): string | undefined => /^\[([a-z_]+)\]/.exec(message.trim())?.[1];

/** Whether a failure is the server refusing the account itself, read off its code where it has one, else the sentence. */
export const refusesAccount = (code: string | undefined, message: string): boolean => {
    const said = code ?? bracketCode(message);
    return said !== undefined && ACCOUNT_REFUSED_CODES.has(said);
};

// The SDK's error carries the server's stable code (CursorSdkError.code); parsed rather than matched by class, since the
// class is not re-exported through the loader this module types against.
export const SdkCodeSchema = z.object({ code: z.string().min(1) });

// A rate limit in the SDK's code vocabulary, matched beside the sentence, since the code is the one half that survives a
// reworded message. A quota's own codes say the plan ran out (the agent store's `quota_exceeded`, `usage_limit`); the
// others say only that requests were turned away (errors.js maps Connect's ResourceExhausted to `resource_exhausted`), a
// throttle unless the words show an allowance spent (limit-cause.ts).
const SPENT_CODES: ReadonlySet<string> = new Set(["quota_exceeded", "usage_limit"]);
const LIMITED_CODES: ReadonlySet<string> = new Set([...SPENT_CODES, "resource_exhausted", "rate_limit"]);

/** A Cursor rate limit as its frame: a spent allowance where its code or words show one, else the throttle it is. */
export const cursorLimitFrame = (message: string, code: string | undefined): Extract<AgentEvent, { kind: "error" }> =>
    limitFrame({ kind: "error", message }, { spent: code !== undefined && SPENT_CODES.has(code) });

// A run that ENDED in error, as against one whose send threw: Cursor reports a spent plan this way, and `RateLimitError`
// is reserved for an HTTP 429, so nothing above ever sees it. Classified here instead of going out bare, which is what
// cost seven refused subagent turns their record in the observed-limit ledger, their hold and their re-run
// (2026-10-13). Only a rate limit is coded: an unknown vendor code must not become a daemon code, and the message
// carries it to the log either way.
export const cursorRunErrorFrame = (error: RunError | undefined): Extract<AgentEvent, { kind: "error" }> => {
    // allow(dependency-text): an emptiness test, not a reading of the SDK's words; an empty message is said as ours.
    const message = error?.message !== undefined && error.message !== "" ? error.message : "The Cursor turn failed.";
    if (refusesAccount(error?.code, message)) {
        return { kind: "error", message, code: "account-not-entitled" };
    }
    const limited = isRateLimited(message) || (error?.code !== undefined && LIMITED_CODES.has(error.code));
    return limited ? cursorLimitFrame(message, error?.code) : { kind: "error", message };
};
