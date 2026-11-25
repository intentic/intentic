import type { CreateElicitationRequest, CreateElicitationResponse } from "@agentclientprotocol/sdk/unstable";
import { ELICITATION_DECLINED, elicitationForm } from "@intentic/acp-events/elicitation";
import type { Json, VendorQuestion } from "@intentic/acp-events/dialects";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { ParkedCards } from "../../conversations/actor/parked-cards.js";

// ACP's form elicitation (`elicitation/create`, mode `form`) onto the question card every runtime shares, the card Pi's
// dialogs and Codex's questions park on. What the form asks and how its reply reads back as the agent's content is the
// shared reading (@intentic/acp-events `elicitationForm`, which a computer's turns ask through too); where the card
// parks is here. URL elicitation is never advertised, so it is declined. An unattended turn's card waits for the owner
// like any other card (agent-request.ts `unattended`).

// What answering needs from the turn: where its card parks, whose conversation raised it, where its frames go, and the
// turn's own stop.
export interface ElicitationContext {
    readonly cards: Pick<ParkedCards, "create">;
    readonly conversationId: string | undefined;
    readonly push: (event: AgentEvent) => void;
    readonly signal: AbortSignal;
}

// Parks one elicitation on a question card and answers it from the person's reply. A dismissal, or the turn ending
// first, is the protocol's `cancel`.
export const answerElicitation = async (request: CreateElicitationRequest, context: ElicitationContext): Promise<CreateElicitationResponse> => {
    const form = elicitationForm(request);
    if (form === undefined) {
        return ELICITATION_DECLINED;
    }
    const { id, wait } = context.cards.create("question", { kind: "question", requestId: "", cancelled: true }, context.conversationId);
    context.push({ kind: "question", requestId: id, questions: [...form.questions] });
    const { reply, resolved } = await wait(context.signal);
    // The resolved frame first, so a replayed transcript freezes the card before anything the agent does next.
    context.push(resolved);
    return form.answer(reply);
};

// A question the agent asks through a request of its own (acp-events dialects `question`, Grok's ask-user tool), parked
// on the same card and answered in the agent's own shape. The turn ending first is the agent's "nobody answered".
export const answerVendorQuestion = async (question: VendorQuestion, context: ElicitationContext): Promise<Json> => {
    const { id, wait } = context.cards.create("question", { kind: "question", requestId: "", cancelled: true }, context.conversationId);
    context.push({ kind: "question", requestId: id, questions: [...question.questions] });
    const { reply, resolved } = await wait(context.signal);
    context.push(resolved);
    return question.answer(reply);
};
