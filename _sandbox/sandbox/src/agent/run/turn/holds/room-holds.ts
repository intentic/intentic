import type { Services } from "../../../../composition.js";
import { waitingOf } from "../../../../conversations/actor/conversation-queue.js";
import type { HeldRecord } from "../../../../conversations/actor/conversation-state.js";
import { rebookedForReopen, spentUntil } from "./allowance-gate.js";

// What a low-memory refusal left waiting: a person's words, held in the conversation's queue (turn-admission.ts,
// handBack), or a turn the sandbox kept whole at the door (`door`), and since when.
export type RoomHold =
    | { readonly conversationId: string; readonly since: number; readonly kind: "queue" }
    | { readonly conversationId: string; readonly since: number; readonly kind: "door"; readonly held: HeldRecord };

// The refusals at the door that a moment's wait clears by itself: the sandbox short of memory, and the sandbox too loaded
// to set up the turn's own view of the workspace in time (setup-refusal.ts). Both wait for the same room, and go on the
// conversation's answer to the memory wall. The card reads the first (agentStatus-standing.ts, memoryHeld).
const ROOM_REFUSALS: ReadonlySet<string> = new Set(["sandbox-memory-low", "workspace-setup"]);

// Whether the turn a conversation last tried was turned away for room.
const roomRefused = (services: Pick<Services, "agents">, conversationId: string): boolean => {
    const ending = services.agents.entry(conversationId)?.ending;
    return ending?.kind === "failed" && ending.code !== undefined && ROOM_REFUSALS.has(ending.code);
};

// Every low-memory hold, longest waiting first, one per conversation.
export const roomHolds = (services: Pick<Services, "agents" | "conversations">): readonly RoomHold[] => {
    const queues = services.conversations.refused().map(({ conversationId, since }): RoomHold => ({ conversationId, since, kind: "queue" }));
    const doors = services.conversations
        .stranded()
        .flatMap(({ conversationId, record }): RoomHold[] =>
            record.reason === "door" && !record.fired ? [{ conversationId, since: record.recordedAt, kind: "door", held: record }] : [],
        );
    const held = [...queues, ...doors].filter((hold) => roomRefused(services, hold.conversationId)).sort((a, b) => a.since - b.since);
    return held.filter((hold, index) => held.findIndex((other) => other.conversationId === hold.conversationId) === index);
};

// Whether a low-memory hold also waits on a spent allowance (allowance-gate.ts): its words, booked for the reopen here
// and now; a turn the sandbox kept, left held for a pass after the reopen.
export const waitsOnAllowance = async (services: Services, hold: RoomHold, now: number): Promise<boolean> =>
    hold.kind === "door"
        ? (await spentUntil(services, { ...hold.held.input, account: hold.held.onto?.account ?? hold.held.input.account }, now)) !== undefined
        : rebookedForReopen(services, hold.conversationId, waitingOf(services.conversations.queued(hold.conversationId)).map((item) => item.id), now);
