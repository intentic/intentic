import type { AgentStatus } from "@intentic/sandbox-contract";
import type { LandStanding } from "../land/standing.js";
import type { EndingStatus } from "../registry/agents-store.js";
import type { ConversationState, ParkKind } from "./conversation-state.js";

// The live turn's word: a chosen ending outranks a park.
const liveStatus = (stopping: "stopped" | "dismissed" | undefined, parked: readonly unknown[]): AgentStatus => {
    if (stopping !== undefined) {
        return stopping === "dismissed" ? "dismissing" : "stopping";
    }
    return parked.length > 0 ? "awaiting" : "running";
};

// Status precedence: the live turn, then an armed resume, then a shown land lease, then how the last turn ended, then the
// land standing; only `idle` yields to the standing. A running turn's own end-of-turn land stays `running`.
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
    return entryStatus === "idle" ? standing : entryStatus;
};

// What the card's attention lanes read: the kinds of every card parked right now, none outside a live turn.
export const parkedKinds = (state: ConversationState | undefined): readonly ParkKind[] =>
    state?.phase.kind === "running" ? state.phase.parked.map((card) => card.kind) : [];
