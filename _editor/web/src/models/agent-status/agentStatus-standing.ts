import { type AgentStanding, type QueueHold, soonestHold } from "@intentic/sandbox-contract/models/agent-standing";

// Every projection of a fleet agent's state (lane, attention label, drill-in verb, glyphs) lives in the contract
// (@intentic/sandbox-contract/models/agent-standing.ts) since 2026-10-16, so the daemon counts what needs the person by the
// same rules (its `agents.attention`, the desktop app's status bar). Re-exported here, where every surface of the editor
// has always imported it; what stays below is the editor's own: a card's standing copied for a tab or another window,
// and the auto-land default.
export {
    soonestHold,
    scheduledSend,
    scheduledCount,
    limited,
    memoryHeld,
    limitClosed,
    limitScheduled,
    limitMoveBooked,
    conflictIsYours,
    watching,
    promptHeldJob,
    heldByPrompt,
    unregistered,
    turnInFlight,
    endingOf,
    endingByHand,
    turnWorking,
    writingNow,
    landBroken,
    bookingAnswers,
    blocked,
    awaitingUser,
    onlyOwnerCanAnswer,
    heardByParent,
} from "@intentic/sandbox-contract/models/agent-standing";
export type { ClientAgentStatus, AgentStanding, EndingByHand } from "@intentic/sandbox-contract/models/agent-standing";

// The scheduled hold alone, copied for a standing that outlives its card (standingFrom); undefined for any other queue.
const scheduledHold = (agent: Pick<AgentStanding, "queue">): QueueHold | undefined => soonestHold(agent.queue);

// A card's standing on its own, carried where a whole card can't go (a chat tab, a summons to another window):
// every field `laneOf` reads and nothing else, with absent ones left out rather than spelled as undefined, since
// this is persisted and posted between windows.
export const standingFrom = (agent: AgentStanding): AgentStanding => {
    const copied = standingCopy(agent);
    const standing = agent.landFailure === undefined ? copied : { ...copied, landFailure: agent.landFailure };
    const hold = scheduledHold(agent);
    return hold === undefined ? standing : { ...standing, queue: hold };
};
const standingCopy = (agent: AgentStanding): AgentStanding => {
    const copy: AgentStanding = {
        status: agent.status,
        // Copied, not referenced: this outlives the roster entry it was read from, in a tab and in storage.
        attention: { ...agent.attention },
        ...(agent.watches !== undefined ? { watches: agent.watches } : {}),
        ...(agent.awaitingWake !== undefined ? { awaitingWake: agent.awaitingWake } : {}),
        ...(agent.conflictCauses !== undefined ? { conflictCauses: agent.conflictCauses } : {}),
        ...(agent.failureCode !== undefined ? { failureCode: agent.failureCode } : {}),
        ...(agent.limitResetsAt !== undefined ? { limitResetsAt: agent.limitResetsAt } : {}),
        ...(agent.limitHeld !== undefined ? { limitHeld: agent.limitHeld } : {}),
        ...(agent.limitScheduled !== undefined ? { limitScheduled: agent.limitScheduled } : {}),
        ...(agent.limitMoving !== undefined ? { limitMoving: agent.limitMoving } : {}),
    };
    // When a booked limit goes, with the rest of its booking, so a copy never states a booking without its instant.
    const booked = agent.limitNextAt === undefined ? copy : { ...copy, limitNextAt: agent.limitNextAt };
    // The jobs go with it: a job at a prompt holds the card's lane (heldByPrompt).
    return agent.jobs === undefined ? booked : { ...booked, jobs: agent.jobs };
};

// Whether a clean turn's work lands by itself, folding the agent's own override, the sandbox default, and the
// schema default (off) into one answer every surface must agree on. Takes plain values rather than reaching for
// stores; this module is a leaf.
export const effectiveAutoLand = (agent: { readonly autoLand?: boolean } | undefined, sandboxDefault: boolean | undefined): boolean =>
    agent?.autoLand ?? sandboxDefault ?? false;
