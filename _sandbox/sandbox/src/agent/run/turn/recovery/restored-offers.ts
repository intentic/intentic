import type {
    CapabilityOfferRequestSchema,
    CredentialOfferRequestSchema,
    PageAskRequestSchema,
    ParkedRequest,
    PaymentOfferRequestSchema,
} from "@intentic/sandbox-contract/events/requests";
import type { AgentReply } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import type { z } from "zod";
import type { Caller } from "../../../../auth/auth.js";
import type { MayAnswer, ParkedCard, ParkedCards } from "../../../../conversations/actor/parked-cards.js";

// THE CARDS A TOOL OR A GATE RAISED, PUT BACK AFTER A RESTART (turn-resume.ts, rehydrateParkedTurn). The call that raised
// each one died with the daemon, so nothing is waiting on its answer: the card goes back up under its own id, and the
// answer is told to a turn of its own, in the words the call would have answered with. What a gate's yes would have
// released (a payment, a credential) is not released by the restored card: the agent makes the call again, and the gate
// asks once more, which is the one answer that moves money or a secret.

type PageAsk = z.infer<typeof PageAskRequestSchema>;
type CapabilityOffer = z.infer<typeof CapabilityOfferRequestSchema>;
type PaymentOffer = z.infer<typeof PaymentOfferRequestSchema>;
type CredentialOffer = z.infer<typeof CredentialOfferRequestSchema>;
export type RestoredOffer = PageAsk | CapabilityOffer | PaymentOffer | CredentialOffer;
// One card of each kind, as the registry hands it back.
type RestoredCard = { readonly [K in RestoredOffer["kind"]]: ParkedCard<K> }[RestoredOffer["kind"]];

// Only the people a credential's card names may answer it, as on the live card (secrets/gates/credential-gate.ts).
const approversOnly =
    (request: CredentialOffer): MayAnswer =>
    (caller) => {
        const { approvers, subject } = request.offer;
        const named = approvers.join(", ");
        if (caller === undefined) {
            return `Only ${named} can release "${subject}", and this request carries no signed-in identity.`;
        }
        return approvers.some((approver) => approver.toLowerCase() === caller.email.toLowerCase()) ? undefined : `Only ${named} can release "${subject}".`;
    };

/** Puts the card back under its own id, settling as its live raiser's abort stand-in would when nobody answers. */
const restoreOffer = (cards: Pick<ParkedCards, "restore">, request: RestoredOffer, conversationId: string): RestoredCard => {
    switch (request.kind) {
        case "page_ask":
            return cards.restore(request.requestId, "page_ask", { kind: "page_ask", requestId: "", cancelled: true }, conversationId);
        case "capability_offer":
            return cards.restore(request.requestId, "capability_offer", { kind: "capability_offer", requestId: "", connect: false }, conversationId);
        case "payment_offer":
            return cards.restore(request.requestId, "payment_offer", { kind: "payment_offer", requestId: "", approve: false }, conversationId);
        case "credential_offer":
            return cards.restore(request.requestId, "credential_offer", { kind: "credential_offer", requestId: "", approve: false }, conversationId, {
                mayAnswer: approversOnly(request),
            });
    }
};

/**
 * Puts any restorable card back under its own id (turn-resume.ts): the turn's own plan, question and permission cards,
 * and the cards a tool or a gate raised.
 */
export const restoreParkedCard = (cards: Pick<ParkedCards, "restore">, request: ParkedRequest, conversationId: string) => {
    switch (request.kind) {
        case "plan":
            return cards.restore(request.requestId, "plan", { kind: "plan", requestId: "", approve: false, feedback: "Planning cancelled." }, conversationId);
        case "question":
            return cards.restore(request.requestId, "question", { kind: "question", requestId: "", cancelled: true }, conversationId);
        case "permission":
            return cards.restore(
                request.requestId,
                "permission",
                { kind: "permission", requestId: "", decision: "deny", feedback: "The turn was cancelled before you answered." },
                conversationId,
            );
        default:
            return restoreOffer(cards, request, conversationId);
    }
};

// The page's answer as the ask tool hands it over (agent/pages/page-tools.ts).
const pageWords = (request: PageAsk, reply: Extract<AgentReply, { kind: "page_ask" }>): string =>
    reply.cancelled !== true && reply.value !== undefined
        ? `The user answered on the page "${request.page.title}":\n${reply.value}`
        : `The user dismissed the page "${request.page.title}" without answering. Carry on with sensible defaults, and say what you assumed.`;

const capabilityWords = (request: CapabilityOffer, reply: Extract<AgentReply, { kind: "capability_offer" }>): string =>
    reply.connect
        ? `The owner said yes to connecting ${request.offer.name} and is setting it up. Nothing waits for it since the sandbox restarted: check \`capabilities list\`, and carry on once it is there.`
        : `The owner chose not to connect ${request.offer.name}. Continue without it, and say what it would have enabled.`;

const paymentWords = (request: PaymentOffer, reply: Extract<AgentReply, { kind: "payment_offer" }>): string => {
    const what = `$${request.offer.amountUsd} for ${request.offer.url}`;
    return reply.approve
        ? `The owner approved paying ${what}, but the sandbox restarted before the payment went out, so nothing was paid. Make the same payment again: the wallet asks once more, and that answer is the one that moves the money.`
        : `The owner declined paying ${what}: nothing was paid. Do not retry; continue without it and say what you left undone.`;
};

const credentialWords = (request: CredentialOffer, reply: Extract<AgentReply, { kind: "credential_offer" }>, caller: Caller | undefined): string => {
    const who = caller?.email ?? "The approver";
    const { subject } = request.offer;
    return reply.approve
        ? `${who} released "${subject}", but the sandbox restarted before anything used it. Make the same call again: the gate asks once more before it releases it.`
        : `${who} declined to release "${subject}": it was not used. Do not retry; continue without it and say what you left undone.`;
};

/** What the turn resumed on this card's answer is told; undefined for a reply of another kind, which settles nothing. */
export const offerAnswerWords = (request: RestoredOffer, reply: AgentReply, caller: Caller | undefined): string | undefined => {
    if (request.kind === "page_ask" && reply.kind === "page_ask") {
        return pageWords(request, reply);
    }
    if (request.kind === "capability_offer" && reply.kind === "capability_offer") {
        return capabilityWords(request, reply);
    }
    if (request.kind === "payment_offer" && reply.kind === "payment_offer") {
        return paymentWords(request, reply);
    }
    if (request.kind === "credential_offer" && reply.kind === "credential_offer") {
        return credentialWords(request, reply, caller);
    }
    return undefined;
};
