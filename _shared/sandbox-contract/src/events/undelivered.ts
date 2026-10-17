import { noticeCode } from "./sandbox-notice.js";
import type { TranscriptRow } from "./transcript.js";

// The row a refusal that ran nothing leaves when the conversation's queue holds the words (transcript-fold's heldRow).
// A turn somebody typed is held in its conversation's queue for another press; a turn that started itself (an
// automation, a loop, a watch wake) has no typed message and nobody watching, so promising a resend there names a
// composer the reader is not looking at. Neither version promises a retry: whether one comes is the scheduler's
// decision, not this row's to state. The code carries the same fact, so the editor's localized line agrees.
export const undeliveredRow = (said: { readonly message: string; readonly error?: string }, unattended: boolean): TranscriptRow => ({
    role: "notice",
    text: unattended
        ? `${said.message} Nothing ran, and nothing is held: this run started on its own, so there is no message waiting to be sent again.`
        : `${said.message} Your message was not delivered: it is held for you to send again.`,
    noticeCode: noticeCode({ code: "undelivered", params: { ...said, unattended: unattended || undefined } }),
});
