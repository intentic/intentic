import type { CardField, TranscriptCards, TranscriptRow } from "./events.js";
import type { AgentReply } from "./schemas/plan-limits.js";

/* HOW A REPLY SETTLES THE CARD IT ANSWERS, the one derivation, used by the fold when the `resolved` frame lands
 * (transcript-fold.ts) and by a chat freezing its own card the instant its answer is accepted, before that
 * frame comes back. Two callers, one rule, which is what keeps "answered" looking the same on the window that
 * clicked and on every window that only watched.
 *
 * No reply is nobody answering: the turn was stopped, or died under the card, which is not a decision, so every
 * card reads `cancelled`. A reply of the wrong kind cannot reach a card of another, the requestId is what
 * matched it, and reads as unanswered rather than inventing a decision. */
type Cards = { -readonly [K in CardField]?: TranscriptRow[K] };

export const settledCards = (cards: TranscriptCards, reply: AgentReply | undefined): TranscriptCards => {
    const out: Cards = {};
    const { plan, question, permission, browserHelp, terminalHelp, serviceOffer, capabilityOffer, paymentOffer, credentialOffer } = cards;
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
            ...permission,
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
    if (serviceOffer !== undefined) {
        out.serviceOffer = { ...serviceOffer, status: reply?.kind !== "service_offer" ? "cancelled" : reply.approve ? "approved" : "skipped" };
    }
    // A yes settles the DECISION, not the ask: the owner is now setting the capability up, so the card moves to
    // `connecting` and stays there until the capability_outcome frame says how the setup ended.
    if (capabilityOffer !== undefined) {
        out.capabilityOffer = {
            ...capabilityOffer,
            status: reply?.kind !== "capability_offer" ? "cancelled" : reply.connect ? "connecting" : "skipped",
        };
    }
    // A yes settles the decision; whether the money actually moved is the payment_receipt frame's to say.
    if (paymentOffer !== undefined) {
        out.paymentOffer = { ...paymentOffer, status: reply?.kind !== "payment_offer" ? "cancelled" : reply.approve ? "approved" : "skipped" };
    }
    /* A yes settles the decision; WHO decided is the credential_receipt frame's to say, because only the
     * daemon knows it — the reply carries no name, the identity was verified off the request that delivered
     * it. A reply that reaches this derivation at all is one the daemon already accepted from an approver: a
     * click from anybody else is refused before the card is settled, so it never gets here and the card stays
     * pending. */
    if (credentialOffer !== undefined) {
        out.credentialOffer = {
            ...credentialOffer,
            status: reply?.kind !== "credential_offer" ? "cancelled" : reply.approve ? "approved" : "skipped",
        };
    }
    return out;
};

/* The same cards with every one still `pending` frozen as `cancelled`: the turn ended out from under the ask
 * (a Stop, a death, a failure) and nobody decided anything. Returns the SAME object when nothing was pending,
 * so a caller can tell a row that changed from one that did not. */
export const cancelledCards = (cards: TranscriptCards): TranscriptCards => {
    const out: Cards = {};
    let changed = false;
    for (const field of [
        "plan",
        "question",
        "permission",
        "browserHelp",
        "terminalHelp",
        "serviceOffer",
        "capabilityOffer",
        "paymentOffer",
        "credentialOffer",
    ] as const) {
        const card = cards[field];
        if (card === undefined) {
            continue;
        }
        if (card.status === "pending") {
            changed = true;
            (out as Record<CardField, unknown>)[field] = { ...card, status: "cancelled" };
        } else {
            (out as Record<CardField, unknown>)[field] = card;
        }
    }
    return changed ? out : cards;
};
