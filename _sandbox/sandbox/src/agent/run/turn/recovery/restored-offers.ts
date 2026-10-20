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
import type { MayAnswer, ParkedCard, ParkedCards, RequestOptions } from "../../../../conversations/actor/parked-cards.js";

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
type RestoredCard = { readonly [K in ParkedRequest["kind"]]: ParkedCard<K> }[ParkedRequest["kind"]];

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

// Who may answer a card and whether a standing yes ever does, read off the card's own frame as its live raiser stamped
// it (guard/card-offers.ts), so a card put back answers to the same rules it went up with: only a credential's approvers
// release it, and a card that asks every time (an owner's hard rule, a restart other conversations feel) is never settled
// by "allow everything in this conversation". 2026-10-20: a restored permission card was put back without its
// `alwaysAsks`, so after a restart a standing yes could answer a hard rule's card the live one never let it touch.
const answeringOf = (request: ParkedRequest): RequestOptions => {
    if (request.kind === "credential_offer") {
        return { mayAnswer: approversOnly(request), alwaysAsks: true };
    }
    return request.kind === "permission" && request.alwaysAsks === true ? { alwaysAsks: true } : {};
};

/**
 * Puts any restorable card back under its own id (turn-resume.ts), settling as its live raiser's abort stand-in would
 * when nobody answers: the turn's own plan, question and permission cards, and the cards a tool or a gate raised.
 */
export const restoreParkedCard = (cards: Pick<ParkedCards, "restore">, request: ParkedRequest, conversationId: string): RestoredCard => {
    const answering = answeringOf(request);
    switch (request.kind) {
        case "plan":
            return cards.restore(request.requestId, "plan", { kind: "plan", requestId: "", approve: false, feedback: "Planning cancelled." }, conversationId, answering);
        case "question":
            return cards.restore(request.requestId, "question", { kind: "question", requestId: "", cancelled: true }, conversationId, answering);
        case "permission":
            return cards.restore(
                request.requestId,
                "permission",
                { kind: "permission", requestId: "", decision: "deny", feedback: "The turn was cancelled before you answered." },
                conversationId,
                answering,
            );
        case "page_ask":
            return cards.restore(request.requestId, "page_ask", { kind: "page_ask", requestId: "", cancelled: true }, conversationId, answering);
        case "capability_offer":
            return cards.restore(request.requestId, "capability_offer", { kind: "capability_offer", requestId: "", connect: false }, conversationId, answering);
        case "payment_offer":
            return cards.restore(request.requestId, "payment_offer", { kind: "payment_offer", requestId: "", approve: false }, conversationId, answering);
        case "credential_offer":
            return cards.restore(request.requestId, "credential_offer", { kind: "credential_offer", requestId: "", approve: false }, conversationId, answering);
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

type PermissionRequest = Extract<ParkedRequest, { kind: "permission" }>;

// A restored permission card's answer, as the turn it resumes takes it.
export interface PermissionAnswer {
    // What the turn is told; undefined ends it quietly.
    readonly words: string | undefined;
    // Whether the turn's re-made call may use the answer once.
    readonly grant: boolean;
}

/**
 * What a restored permission card's answer tells the turn it resumes (undefined for a bare deny, which ends the turn as a
 * live one does), and whether it is a grant the turn's re-made call may use once. A held child start's card answers the
 * start, which its own record carries on with (agent/subagents/child-restore.ts): told to run the call again, the turn
 * started the child a second time, so it is told the start is under way instead.
 */
export const permissionAnswer = (request: PermissionRequest, reply: Extract<AgentReply, { kind: "permission" }>): PermissionAnswer => {
    if (reply.decision === "deny") {
        // Feedback is a redirection the turn takes.
        const feedback = reply.feedback?.trim() ?? "";
        return { words: feedback === "" ? undefined : feedback, grant: false };
    }
    if (request.child?.move === "spawn") {
        const task = request.child.task === undefined ? "" : ` ("${request.child.task}")`;
        return { words: `The owner allowed the subagent start you asked for${task}: it starts by itself and its report reaches you when it ends. Do not start it again.`, grant: false };
    }
    // A one-shot grant, with no waiting tool call to feed; `always` still carries the don't-ask-again flavour through.
    return { words: `The user allowed ${request.toolName}: run it and continue where the session left off.`, grant: true };
};
