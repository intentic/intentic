import { planParts, REQUEST_FIELDS } from "@intentic/sandbox-contract";
import { type AgentStanding, awaitingUser } from "../../../agents/fleet/agentStatus";
import type { ChatMessage } from "../../transcript/transcript";
import { newestOf } from "../../transcript/transcriptScan";

// What a chat waits on a person for, as the bar pinned above its composer names it (ChatWaitingBar): the card this window
// drew, or, before it has drawn one, what the agents list says. The card itself sits in the transcript, where a reader
// scrolled elsewhere never saw it (one question waited 3 h 36 min), so the bar says it at every scroll position.

/** Which ask: the three with a line of their own, and every other hand-off (browser, terminal, a setup, an offer). */
export type WaitKind = `plan` | `question` | `permission` | `other`;

export interface PendingDecision {
    readonly kind: WaitKind;
    /** The ask in a line: a plan's heading, a lone question, the tool a permission is for. Absent where there is none. */
    readonly title?: string;
    /** The drawn card's request id; absent while only the agents list says it waits, and the card is still on its way. */
    readonly requestId?: string;
}

// The card a row holds, read the way the card itself titles it.
const decisionIn = (message: ChatMessage): PendingDecision | undefined => {
    if (message.plan?.status === `pending`) {
        return { kind: `plan`, requestId: message.plan.requestId, ...titled(planParts(message.plan.text).title) };
    }
    if (message.question?.status === `pending`) {
        const asks = message.question.questions;
        return { kind: `question`, requestId: message.question.requestId, ...titled(asks.length === 1 ? asks[0]?.question : undefined) };
    }
    // A page asked to be answered on is a question in another form, named by the page's own title.
    if (message.pageAsk?.status === `pending`) {
        return { kind: `question`, requestId: message.pageAsk.requestId, ...titled(message.pageAsk.page.title) };
    }
    if (message.permission?.status === `pending`) {
        const { displayName, toolName, requestId } = message.permission;
        return { kind: `permission`, requestId, ...titled(displayName ?? toolName) };
    }
    // Any other card still waiting (a browser or terminal hand-off, an offer) is drawn too: its id is what lets the bar
    // scroll to it rather than re-read the whole transcript on every press.
    const other = REQUEST_FIELDS.map((field) => message[field]).find((card) => card?.status === `pending`);
    return other === undefined ? undefined : { kind: `other`, requestId: other.requestId };
};

const titled = (title: string | undefined): { title?: string } => (title === undefined || title.trim() === `` ? {} : { title: title.trim() });

/** The newest card in the transcript still waiting on an answer. */
export const pendingCardOf = (messages: readonly ChatMessage[]): PendingDecision | undefined => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        const decision = message === undefined ? undefined : decisionIn(message);
        if (decision !== undefined) {
            return decision;
        }
    }
    return undefined;
};

/**
 * The same, as a reader that reads only the rows changed since its last read (transcriptScan.ts): the bar asks on every
 * frame of a streamed turn, and a transcript with no card waiting was walked whole each time. One per transcript.
 */
export const pendingCardReader = (): ((messages: readonly ChatMessage[]) => PendingDecision | undefined) => newestOf(decisionIn);

/** What the agents list says the chat waits on a person for, in the board's own rank; undefined when it waits on nobody. */
export const waitKindOf = (agent: AgentStanding): WaitKind | undefined => {
    if (!awaitingUser(agent)) {
        return undefined;
    }
    if (agent.attention.plan) {
        return `plan`;
    }
    if (agent.attention.question) {
        return `question`;
    }
    return agent.attention.permission ? `permission` : `other`;
};

/** The drawn card when there is one; otherwise what the agents list says, so the bar stands before the card arrives. */
export const pendingDecisionOf = (
    messages: readonly ChatMessage[],
    waitsOn: WaitKind | undefined,
    read: (messages: readonly ChatMessage[]) => PendingDecision | undefined = pendingCardOf,
): PendingDecision | undefined => read(messages) ?? (waitsOn === undefined ? undefined : { kind: waitsOn });
