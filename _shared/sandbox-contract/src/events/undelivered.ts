import { undeliveredClause } from "../policy/deterministic-refusals.js";
import { noticeCode } from "./sandbox-notice.js";
import type { TranscriptRow } from "./transcript.js";

// The row a refusal that ran nothing leaves (transcript-fold's heldRow), whether the conversation's queue holds the
// words or the sandbox kept the turn whole (`kept`). Its clause and its code carry the same two facts, so the editor's
// localized line (sandboxNotice.ts) and this English one never disagree about whether a resend is promised.
export const undeliveredRow = (
    message: string,
    said: { readonly message: string; readonly error?: string },
    how: { readonly unattended: boolean; readonly deterministic: boolean; readonly kept: boolean },
): TranscriptRow => {
    const params = { ...said, unattended: how.unattended || undefined, deterministic: how.deterministic || undefined };
    const row: TranscriptRow = { role: "notice", text: `${message} ${undeliveredClause(how.unattended, how.deterministic)}`, noticeCode: noticeCode({ code: "undelivered", params }) };
    // A kept turn's row stays the sandbox's (sandboxHeld). heldRow sends it here only when it was refused for good, so
    // it offers no resend: the chat answers it with a new chat instead (the editor's keptForGood).
    return how.kept ? { ...row, sandboxHeld: true } : row;
};
