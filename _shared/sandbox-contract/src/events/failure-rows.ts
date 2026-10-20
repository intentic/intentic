import type { AgentEvent } from "./agent-events.js";
import { type FailureSaid, type NoticeCode, noticeCode } from "./sandbox-notice.js";
import type { TranscriptRow } from "./transcript.js";
import { anotherModelClears, turnedAwayCode } from "../policy/turned-away.js";

/* EVERY ROW A FAILURE LEAVES, in one place: the fold's one way from an `error` frame to a notice. Each row is coded,
   whatever the frame carried, so no reader ever has to guess from a row's words whether it is a failure, or what kind:
   a failure nobody named is `failed` with no `error`, the unclassified kind, never bare text (2026-10-20: a week of
   transcripts held 105 failure rows written as bare provider words, a spent allowance's among them, against 34 coded). */

type ErrorFrame = Extract<AgentEvent, { kind: "error" }>;
type FailureRow = TranscriptRow & { readonly noticeCode: NoticeCode };

// A failure's own sentence, its code and who worded it, which every failure row carries ahead of the clause it adds.
const failureOf = (event: ErrorFrame): FailureSaid => ({ message: event.message, error: event.code, own: event.own === true ? true : undefined });

const failedRow = (event: ErrorFrame): FailureRow => ({
    role: "notice",
    text: event.message,
    noticeCode: noticeCode({ code: "failed", params: failureOf(event) }),
});

// The row a refusal that ran nothing leaves when the conversation's queue holds the words (heldRow). A turn somebody typed
// is held in its conversation's queue for another press; a turn that started itself (an automation, a loop, a watch wake)
// has no typed message and nobody watching, so promising a resend there names a composer the reader is not looking at.
// Neither version promises a retry: whether one comes is the scheduler's decision, not this row's to state.
const undeliveredRow = (said: FailureSaid, unattended: boolean): FailureRow => ({
    role: "notice",
    text: unattended
        ? `${said.message} Nothing ran, and nothing is held: this run started on its own, so there is no message waiting to be sent again.`
        : `${said.message} Your message was not delivered: it is held for you to send again.`,
    noticeCode: noticeCode({ code: "undelivered", params: { ...said, unattended: unattended || undefined } }),
});

// The row the same refusal leaves once the turn had already run: a trial spent, or a model refused, on a later step. The
// message was read and acted on, so it is neither undelivered nor held (turn-runs keeps only a turn turned away at the
// door), and saying so invited a resend of something that had already changed files (onboarding review 2026-10-18,
// F07). What it did stays in the conversation's copy; the press, when another model gets past the refusal, carries on there.
const stoppedPartwayRow = (said: FailureSaid, switchModel: boolean): FailureRow => {
    const row: FailureRow = {
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

// The press a memory hold offers: the raise rides along only when the hold carried a ceiling to size it by, since a
// stall names none and raising one would not clear it.
const memoryPress = (event: ErrorFrame): "sendAnyway" | "sandboxMemory" => (event.memory === undefined ? "sendAnyway" : "sandboxMemory");

// A memory hold is asked once and never again that spell (resource-budget.ts), so the next send always runs. A turn the
// sandbox started itself (a fix press, a peer's message, a re-run) was never in a composer: its message stays above, and
// the press asks the sandbox to run the turn it kept rather than sending a queue that holds nothing.
const heldRow = (event: ErrorFrame): FailureRow => {
    const unattended = event.unattended === true;
    const memory = event.code === "sandbox-memory-low";
    const said = failureOf(event);
    if (event.held !== undefined && !unattended) {
        return {
            role: "notice",
            text: memory
                ? `${event.message} Nothing has run yet: the message above is kept here, and sending it anyway starts it.`
                : `${event.message} Nothing has run yet: the message above is kept here to send again once that is sorted.`,
            noticeAction: memory ? memoryPress(event) : "sendAgain",
            sandboxHeld: true,
            noticeCode: noticeCode({ code: "kept", params: { ...said, memory: memory || undefined } }),
        };
    }
    if (!memory || unattended) {
        return undeliveredRow(said, unattended);
    }
    return {
        role: "notice",
        text: `${event.message} Your message is held: send it again to start anyway.`,
        noticeAction: memoryPress(event),
        noticeCode: noticeCode({ code: "memoryHeld", params: said }),
    };
};

// What an armed credential renewal promises, and what its row says instead once a later failure in the same run took
// that promise back (TranscriptFold.withdrawRenewal).
export const RENEWING = "The credential is being renewed and this turn continues automatically.";
export const RENEWAL_WITHDRAWN =
    "The credential was being renewed, but the turn stopped before it could continue: it will not carry on by itself, so press Continue to pick it back up.";

// What a laddered wall's automatic re-runs are doing, said on the failure's own row so the count stays in the record.
const retryClause = (event: ErrorFrame): { text: string; code: NoticeCode } | undefined => {
    const { retries } = event;
    if (retries === undefined) {
        return undefined;
    }
    const said = failureOf(event);
    if (event.autoResume === "scheduled") {
        return {
            text: `Retrying by itself: attempt ${retries.made + 1} of ${retries.max}.`,
            code: noticeCode({ code: "retrying", params: { ...said, attempt: retries.made + 1, of: retries.max } }),
        };
    }
    return retries.made >= retries.max
        ? {
              text: `Retried ${retries.made} of ${retries.max} times by itself; nothing more is sent automatically.`,
              code: noticeCode({ code: "retried", params: { ...said, made: retries.made, of: retries.max } }),
          }
        : undefined;
};

/** The row a turn-ending failure leaves: its own sentence plus one clause on what happens next, coded whatever it was.
 *  The live wait itself is drawn by the chat, not stored here. `ran`: an assistant row stands, so a door refusal stopped
 *  the turn partway. */
export const errorRow = (event: ErrorFrame, ran: boolean): FailureRow => {
    const { message, code } = event;
    const said = failureOf(event);
    if (code === "provider-outage") {
        const retry = retryClause(event);
        return retry === undefined
            ? {
                  role: "notice",
                  text: `${message} Nothing is retrying it, so the turn is waiting here.`,
                  noticeCode: noticeCode({ code: "outageWaiting", params: said }),
              }
            : { role: "notice", text: `${message} ${retry.text}`, noticeCode: retry.code };
    }
    if (code === "claude-token-refused") {
        return event.autoResume === "scheduled"
            ? {
                  role: "notice",
                  text: `${message} ${RENEWING}`,
                  noticeWait: "credentialRenewal",
                  noticeCode: noticeCode({ code: "renewing", params: said }),
              }
            : {
                  role: "notice",
                  text: `${message} Reconnect the account to pick this conversation back up.`,
                  noticeCode: noticeCode({ code: "reconnect", params: said }),
              };
    }
    if (!turnedAwayCode(code)) {
        const retry = retryClause(event);
        return retry === undefined ? failedRow(event) : { role: "notice", text: `${message} ${retry.text}`, noticeCode: retry.code };
    }
    return ran && event.held === undefined ? stoppedPartwayRow(said, anotherModelClears(code)) : heldRow(event);
};
