import { CONVERSATION_HEADER, TURN_PROOF_HEADER, turnProof } from "./workload-stamp.js";

/** The headers an agent's CLI sends for `conversationId`: its name and this daemon run's proof of it. */
export const provenTurnHeaders = (conversationId: string) => ({
    [CONVERSATION_HEADER]: conversationId,
    [TURN_PROOF_HEADER]: turnProof(conversationId),
});
