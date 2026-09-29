import type { AgentReply, WaitingPermission } from "@intentic/sandbox-contract";
import { postTurnControl } from "../../chat/run/turnStream";
import { SKIP_CALL } from "../../chat/session/cardReplies";
import type { FleetAgent } from "./useAgents-fleet";
import { claim } from "./useAgents-provisional";

// A permission answered on the board card itself, not a trip to a chat that may still be loading: the chat card's
// first answer and its "skip this, keep going". "Always" and the No that stops the turn stay in the chat, where the
// card says what each would do.
export type BoardAnswer = `once` | `skip`;

// What a card can answer where it is drawn: the oldest permission its running turn waits on, while the flag stands and
// the card is live. None from a sandbox too old to send it, which leaves the drill-in to the chat as the one way.
export const answerableAsk = (agent: Pick<FleetAgent, "attention" | "permissionAsk" | "archivedAt">): WaitingPermission | undefined =>
    agent.archivedAt === undefined && agent.attention.permission ? agent.permissionAsk : undefined;

// The reply an answer sends, addressed to the request the card named.
export const boardReply = (ask: WaitingPermission, answer: BoardAnswer): AgentReply =>
    answer === `once` ? { kind: `permission`, requestId: ask.requestId, decision: `once` } : { ...SKIP_CALL, requestId: ask.requestId };

// Sends it; true once the sandbox took it. The card reads answered from the press (the same claim a chat's answer
// makes), and goes back to asking when the answer did not take.
export const answerFromBoard = async (agent: Pick<FleetAgent, "id" | "sandboxId">, ask: WaitingPermission, answer: BoardAnswer): Promise<boolean> => {
    const press = claim(agent.id, agent.sandboxId, `answer`, `permission`);
    const taken = await postTurnControl(agent.sandboxId, `reply`, boardReply(ask, answer));
    press.settle(taken);
    return taken;
};
