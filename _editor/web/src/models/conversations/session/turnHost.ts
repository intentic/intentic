import type { Conversation } from "./conversation";

// What a run reads and writes of the conversation around it.
export type TurnHost = Pick<
    Conversation,
    | "conversationId"
    | "transcript"
    | "selection"
    | "failures"
    | "title"
    | "isolated"
    | "runner"
    | "box"
    | "registered"
    | "standing"
    | "pendingForkOf"
    | "pendingFreshOf"
    | "pendingFromBranch"
    | "error"
    | "pickUp"
    | "session"
    | "agentTerminal"
    | "agentBrowser"
    | "peek"
    | "draft"
    | "attachments"
    | "queue"
    | "sendLater"
    | "autoLandDraft"
>;
