import type { AgentStatus, ParkKind } from "@intentic/sandbox-contract";
import type { LandStanding } from "../land/standing.js";
import type { EndingStatus } from "../registry/agents-store.js";
import { awaitingWake, type ConversationState } from "./conversation-state.js";

// The live turn's word: a chosen ending outranks a park.
const liveStatus = (stopping: "stopped" | "dismissed" | undefined, parked: readonly unknown[]): AgentStatus => {
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
