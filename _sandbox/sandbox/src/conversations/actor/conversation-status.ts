import type { AgentStatus, ParkKind, WaitingPermission } from "@intentic/sandbox-contract";
import type { LandStanding } from "../land/standing.js";
import type { EndingStatus } from "../registry/agents-store.js";
import { awaitingWake, type ConversationState, type StopEnding } from "./conversation-state.js";

// The live turn's word: a chosen ending outranks a park.
const liveStatus = (stopping: StopEnding | undefined, parked: readonly unknown[]): AgentStatus => {
    if (stopping !== undefined) {
        return stopping === "dismissed" ? "dismissing" : "stopping";
    }
    return parked.length > 0 ? "awaiting" : "running";
};

// Precedence: live turn, armed resume, shown land lease (a turn's own land stays `running`), ending, land standing. Only
// `idle` yields to the standing, and its `ready` (finished work awaiting a land) is `idle` while the conversation wakes.
export const conversationStatus = (
    state: ConversationState | undefined,
    entryStatus: EndingStatus,
    standing: LandStanding,
): AgentStatus => {
    if (state?.phase.kind === "running") {
        return liveStatus(state.phase.stopping, state.phase.parked);
    }
    if (state?.turn.resuming === true) {
        return "resuming";
    }
    if (state?.turn.landing === true) {
        return "landing";
    }
    if (entryStatus !== "idle") {
        return entryStatus;
    }
    return standing === "ready" && state !== undefined && awaitingWake(state) ? "idle" : standing;
};

// What the card's attention lanes read: the kinds of every card parked right now, none outside a live turn.
export const parkedKinds = (state: ConversationState | undefined): readonly ParkKind[] =>
    state?.phase.kind === "running" ? state.phase.parked.map((card) => card.kind) : [];

// The oldest permission parked right now, as a card can answer it (AgentSummary.permissionAsk); none outside a live
// turn, and none a stop is already unwinding, whose cards no answer reaches.
export const permissionAskOf = (state: ConversationState | undefined): WaitingPermission | undefined => {
    if (state?.phase.kind !== "running" || state.phase.stopping !== undefined) {
        return undefined;
    }
    const card = state.phase.parked.find((parked) => parked.kind === "permission");
    return card === undefined ? undefined : { requestId: card.requestId, ask: card.ask ?? "" };
};
