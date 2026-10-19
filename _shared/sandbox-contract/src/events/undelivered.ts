import { noticeCode } from "./sandbox-notice.js";
import type { TranscriptRow } from "./transcript.js";

// The row a refusal that ran nothing leaves when the conversation's queue holds the words (transcript-fold's heldRow).
// A turn somebody typed is held in its conversation's queue for another press; a turn that started itself (an
// automation, a loop, a watch wake) has no typed message and nobody watching, so promising a resend there names a
// composer the reader is not looking at. Neither version promises a retry: whether one comes is the scheduler's
// decision, not this row's to state. The code carries the same fact, so the editor's localized line agrees.
// The row the same refusal leaves once the turn had already run: a trial spent, or a model refused, on a later step. The
// message was read and acted on, so it is neither undelivered nor held (turn-runs keeps only a turn turned away at the
// door), and saying so invited a resend of something that had already changed files (onboarding review 2026-10-18,
// F07). What it did stays in the conversation's copy; the press, when another model gets past the refusal, carries on there.
export const stoppedPartwayRow = (said: { readonly message: string; readonly error?: string }, switchModel: boolean): TranscriptRow => {
    const row: TranscriptRow = {
        role: "notice",
        text: switchModel
            ? `${said.message} The run stopped partway. The changes it made so far are kept: continue with another model to pick up from here.`
            : `${said.message} The run stopped partway. The changes it made so far are kept: send a message to pick up from here.`,
        noticeCode: noticeCode({ code: "stoppedPartway", params: { ...said, switchModel: switchModel || undefined } }),
    };
    if (switchModel) {
        row.noticeAction = "switchModel";
    }
    return row;
};

export const undeliveredRow = (said: { readonly message: string; readonly error?: string }, unattended: boolean): TranscriptRow => ({
    role: "notice",
    text: unattended
        ? `${said.message} Nothing ran, and nothing is held: this run started on its own, so there is no message waiting to be sent again.`
        : `${said.message} Your message was not delivered: it is held for you to send again.`,
    noticeCode: noticeCode({ code: "undelivered", params: { ...said, unattended: unattended || undefined } }),
});
