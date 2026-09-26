import { REQUEST_FIELDS, type RequestField, type TranscriptRequests, type TranscriptRow } from "../events/transcript.js";
import type { AgentReply } from "../schemas/providers/plan-limits.js";
import { startedChildCard } from "../events/child-run.js";

// How a reply settles the card it answers: one rule used both by the fold and by a chat freezing its own card
// optimistically before the frame returns. No reply (turn stopped or died) reads as cancelled for every card; a reply
// of the wrong kind cannot settle a card of another, since requestId is what matches them.
type Cards = { -readonly [K in RequestField]?: TranscriptRow[K] };

export const settledRequests = (cards: TranscriptRequests, reply: AgentReply | undefined): TranscriptRequests => {
    const out: Cards = {};
    const { plan, question, permission, browserHelp, terminalHelp, capabilityOffer, paymentOffer, credentialOffer } = cards;
    if (plan !== undefined) {
        out.plan = { ...plan, status: reply?.kind !== "plan" ? "cancelled" : reply.approve ? "approved" : "rejected" };
    }
    if (question !== undefined) {
        const answers = reply?.kind === "question" ? reply.answers : undefined;
        out.question = {
            ...question,
            status: reply?.kind === "question" && reply.cancelled !== true ? "answered" : "cancelled",
            ...(answers === undefined ? {} : { answers }),
        };
    }
    if (permission !== undefined) {
        out.permission = {
            ...startedChildCard(permission, reply),
            status:
                reply?.kind !== "permission"
                    ? "cancelled"
                    : reply.decision === "deny"
                      ? "denied"
                      : reply.decision === "always"
                        ? "always"
                        : "allowed",
        };
    }
    if (browserHelp !== undefined) {
        out.browserHelp = { ...browserHelp, status: reply?.kind !== "browser_help" ? "cancelled" : reply.helped ? "helped" : "declined" };
    }
    if (terminalHelp !== undefined) {
        out.terminalHelp = { ...terminalHelp, status: reply?.kind !== "terminal_help" ? "cancelled" : reply.helped ? "helped" : "declined" };
    }
    // A yes settles the decision, not the ask: the card moves to connecting until capability_outcome resolves it.
    if (capabilityOffer !== undefined) {
        out.capabilityOffer = {
            ...capabilityOffer,
            status: reply?.kind !== "capability_offer" ? "cancelled" : reply.connect ? "connecting" : "skipped",
        };
    }
    // A yes settles the decision; whether the money moved is the payment_receipt frame's to say.
    if (paymentOffer !== undefined) {
        out.paymentOffer = { ...paymentOffer, status: reply?.kind !== "payment_offer" ? "cancelled" : reply.approve ? "approved" : "skipped" };
    }
    // A yes settles the decision; who decided is the credential_receipt frame's, since only the daemon knows.
    if (credentialOffer !== undefined) {
        out.credentialOffer = {
            ...credentialOffer,
            status: reply?.kind !== "credential_offer" ? "cancelled" : reply.approve ? "approved" : "skipped",
        };
    }
    return out;
};

// Freezes every still-pending card as cancelled: the turn ended (stopped, died, failed) before anyone decided. Returns
// the same object when nothing was pending, so a caller can tell a changed row from an unchanged one.
export const cancelledRequests = (cards: TranscriptRequests): TranscriptRequests => {
    const out: Cards = {};
    let changed = false;
    for (const field of REQUEST_FIELDS) {
        const card = cards[field];
        if (card === undefined) {
            continue;
        }
        if (card.status === "pending") {
            changed = true;
            (out as Record<RequestField, unknown>)[field] = { ...card, status: "cancelled" };
        } else {
            (out as Record<RequestField, unknown>)[field] = card;
        }
    }
    return changed ? out : cards;
};
