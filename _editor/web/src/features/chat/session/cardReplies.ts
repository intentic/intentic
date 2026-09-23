import { type AgentReply, type RequestField, settledRequests, type TranscriptRequests } from "@intentic/sandbox-contract";
import { ref } from "vue";
import { postTurnControl } from "../run/turnStream";
import type { ChatAttachment, ChatMessage } from "../transcript/transcript";
import type { Conversation } from "./conversation";
import type { TranscriptView } from "./transcriptView";
import type { TurnClient } from "./turnClient";

// The one way a turn parked on a card is answered, whatever the card: a plan, a question, a permission prompt, the
// browser and terminal help asks, the capability, payment and credential offers. The daemon un-parks the turn first and
// the card freezes only once that landed, by the same rule the daemon's own `resolved` row uses (settledRequests).

type WithoutRequest<R> = R extends unknown ? Omit<R, "requestId"> : never;

// A card's answer as the contract types it, less the request id `reply` is addressed by.
export type CardAnswer = WithoutRequest<AgentReply>;

// Which transcript field holds the card each kind of answer settles.
const FIELD_OF: Readonly<Record<CardAnswer["kind"], RequestField>> = {
    plan: `plan`,
    question: `question`,
    permission: `permission`,
    browser_help: `browserHelp`,
    terminal_help: `terminalHelp`,
    capability_offer: `capabilityOffer`,
    payment_offer: `paymentOffer`,
    credential_offer: `credentialOffer`,
};

// What the red line says when the daemon didn't take an answer, in the words each card has always used.
export const refusalOf = (answer: CardAnswer): string => {
    switch (answer.kind) {
        case `plan`:
            return `Could not record your plan decision: the turn may have ended.`;
        case `question`:
            return answer.cancelled === true
                ? `Could not dismiss the question: the turn may have ended.`
                : `Could not submit your answers: the turn may have ended.`;
        case `permission`:
            return `Could not record your decision: the turn may have ended.`;
        case `payment_offer`:
            return `Could not record your decision: the offer may have expired.`;
        // The one card whose answer can be refused on who is pressing: enforced server-side against the verified identity.
        case `credential_offer`:
            return `Could not record your decision: the card may have expired, or it may not be yours to answer.`;
        case `capability_offer`:
            return `Could not record your decision: the ask may have expired.`;
        case `browser_help`:
        case `terminal_help`:
            return `Could not send that: the turn may have ended.`;
    }
};

// What a landed answer does to the turn: a dismissed question ends it (both lines, "Question dismissed." and
// "Stopped.", are the daemon's own); a denial with nothing to steer by stops it; anything else lets it go on, and the
// daemon says into it whatever waited behind the card, for every window at once.
export const afterReply = (answer: CardAnswer): "end" | "stop" | "go on" => {
    if (answer.kind === `question` && answer.cancelled === true) {
        return `end`;
    }
    if (answer.kind === `permission` && answer.decision === `deny` && answer.feedback === undefined) {
        return `stop`;
    }
    return `go on`;
};

// A plan's rejection feedback: what was typed, and the staged files as `@`-prefixed workspace paths, the one text field
// the wire reply has; undefined when there is neither.
export const planFeedback = (text: string | undefined, attachments: readonly ChatAttachment[] = []): string | undefined => {
    const written = [text?.trim(), ...attachments.map((file) => `@${file.path}`)].filter(Boolean).join(`\n`);
    return written.length > 0 ? written : undefined;
};

// The request id of the card a row holds; a row holds at most one.
export const requestIdOf = (row: TranscriptRequests): string | undefined =>
    Object.values(FIELD_OF)
        .map((field) => row[field]?.requestId)
        .find((requestId) => requestId !== undefined);

// What replying reads and writes of the conversation around it.
type RepliesHost = Pick<Conversation, "box" | "error" | "peek"> & {
    readonly transcript: Pick<TranscriptView, "messages" | "attachCard">;
    readonly turn: Pick<TurnClient, "stop" | "endedByReader">;
};

export class CardReplies {
    // Cards whose answer is in flight, by request id; claimed before the request leaves so it can't double-answer.
    private readonly replying = ref<ReadonlySet<string>>(new Set());

    constructor(private readonly host: RepliesHost) {}

    /** Whether this card's answer is on its way, for the view that must stop offering the other answers. */
    isReplying(requestId: string): boolean {
        return this.replying.value.has(requestId);
    }

    // Answers the still-pending card `requestId` names; false when there is none to answer, a second press is already
    // on its way, or the daemon didn't take it (said on the red line, and the card stays answerable).
    async reply(requestId: string, answer: CardAnswer): Promise<boolean> {
        const field = FIELD_OF[answer.kind];
        const message = this.host.transcript.messages.value.find((row) => row[field]?.status === `pending` && row[field]?.requestId === requestId);
        if (message === undefined || this.replying.value.has(requestId)) {
            return false;
        }
        this.host.peek.value = false;
        this.replying.value = new Set(this.replying.value).add(requestId);
        try {
            const body = { ...answer, requestId } as AgentReply;
            if (!(await postTurnControl(this.host.box.value, `reply`, body))) {
                this.host.error.value = refusalOf(answer);
                return false;
            }
            // The same derivation the daemon uses for the `resolved` row, applied here so the card reads answered; only
            // this card, since the rule reads every other one it is handed as left unanswered.
            this.host.transcript.attachCard(message.id, settledRequests(cardOf(message, field), body));
        } finally {
            // Released even on failure: the card goes back to `pending` on screen, so it must be answerable again.
            const left = new Set(this.replying.value);
            left.delete(requestId);
            this.replying.value = left;
        }
        const next = afterReply(answer);
        if (next === `end`) {
            this.host.turn.endedByReader();
        } else if (next === `stop`) {
            this.host.turn.stop();
        }
        return true;
    }
}

// One card of a row, alone, in the shape the settling rule reads.
const cardOf = (message: ChatMessage, field: RequestField): TranscriptRequests => ({ [field]: message[field] });
