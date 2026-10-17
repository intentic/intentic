import type { RunError } from "@cursor/sdk";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { z } from "zod";
import { mentionsSpentAllowance } from "../../../engines/failure-sentences.js";

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

// What a run's own terminal error calls a spent allowance, in the SDK's code vocabulary (errors.js maps Connect's
// ResourceExhausted to `resource_exhausted`; the agent store's own quota uses `quota_exceeded`). Matched beside the
// sentence, since the code is the one half that survives a reworded message.
const EXHAUSTED_RUN_CODES: ReadonlySet<string> = new Set(["resource_exhausted", "rate_limit", "quota_exceeded", "usage_limit"]);

// A run that ENDED in error, as against one whose send threw: Cursor reports a spent plan this way, and `RateLimitError`
// is reserved for an HTTP 429, so nothing above ever sees it. Classified here instead of going out bare, which is what
// cost seven refused subagent turns their record in the observed-limit ledger, their hold and their re-run
// (2026-10-13). Only a spent allowance is coded: an unknown vendor code must not become a daemon code, and the message
// carries it to the log either way.
export const cursorRunErrorFrame = (error: RunError | undefined): Extract<AgentEvent, { kind: "error" }> => {
    // allow(dependency-text): an emptiness test, not a reading of the SDK's words; an empty message is said as ours.
    const message = error?.message !== undefined && error.message !== "" ? error.message : "The Cursor turn failed.";
    if (refusesAccount(error?.code, message)) {
        return { kind: "error", message, code: "account-not-entitled" };
    }
    const spent = mentionsSpentAllowance(message) || (error?.code !== undefined && EXHAUSTED_RUN_CODES.has(error.code));
    return spent ? { kind: "error", message, code: "rate_limit" } : { kind: "error", message };
};
