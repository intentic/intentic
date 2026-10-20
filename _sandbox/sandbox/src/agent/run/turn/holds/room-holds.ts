import type { Services } from "../../../../composition.js";
import { waitingOf } from "../../../../conversations/actor/conversation-queue.js";
import { roomRefused } from "../../../../conversations/actor/conversation-next.js";
import type { HeldRecord } from "../../../../conversations/actor/conversation-state.js";
import { breakArmed } from "@intentic/sandbox-contract/schemas/turn-break";
import type { DueAt } from "../../../../workload/nudged-pass.js";
import { breakPolicyFor } from "../break-policy.js";
import { rebookedForReopen, spentUntil } from "./allowance-gate.js";

// What a low-memory refusal left waiting: a person's words, held in the conversation's queue (turn-admission.ts,
// handBack), or a turn the sandbox kept whole at the door (`door`), and since when.
export type RoomHold =
    | { readonly conversationId: string; readonly since: number; readonly kind: "queue" }
    | { readonly conversationId: string; readonly since: number; readonly kind: "door"; readonly held: HeldRecord };

// Every low-memory hold, longest waiting first, one per conversation.
const roomHolds = (services: Pick<Services, "agents" | "conversations">): readonly RoomHold[] => {
    const queues = services.conversations.refused().map(({ conversationId, since }): RoomHold => ({ conversationId, since, kind: "queue" }));
    const doors = services.conversations
        .stranded()
        .flatMap(({ conversationId, record }): RoomHold[] =>
            record.reason === "door" && !record.fired ? [{ conversationId, since: record.recordedAt, kind: "door", held: record }] : [],
        );
    // Turned away for room, by the rule the card's `next` reads too (conversation-next.ts).
    const held = [...queues, ...doors].filter((hold) => roomRefused(services.agents.entry(hold.conversationId)?.ending)).sort((a, b) => a.since - b.since);
    return held.filter((hold, index) => held.findIndex((other) => other.conversationId === hold.conversationId) === index);
};

// Whether a low-memory hold also waits on a spent allowance (allowance-gate.ts): its words, booked for the reopen here
// and now; a turn the sandbox kept, left held for a pass after the reopen.
const waitsOnAllowance = async (services: Services, hold: RoomHold, now: number): Promise<boolean> =>
    hold.kind === "door"
        ? (await spentUntil(services, { ...hold.held.input, account: hold.held.onto?.account ?? hold.held.input.account }, now)) !== undefined
        : rebookedForReopen(services, hold.conversationId, waitingOf(services.conversations.queued(hold.conversationId)).map((item) => item.id), now);

// How long memory must stay free before a hold waiting for room lets anything go: one good reading between two short ones
// is not memory calming down, and a turn let go into it is refused again, with a second notice in its chat.
export const ROOM_SETTLE_MS = 30_000;

// How often a hold waiting for room looks at memory while it is still short: nothing announces memory freeing up but a
// turn ending (which nudges the pass), so this keeps the pass's old beat for the rest (2026-10-20).
const ROOM_LOOK_MS = 5_000;

// Lets one low-memory hold go, once memory has stayed free for ROOM_SETTLE_MS, and only where the conversation's answer to
// the memory wall is to send it then. One a pass, longest waiting first: the next is judged on a reading that counts the
// room the first one took (resource-budget.ts reservations), where letting them all go into one good reading would have
// every one of them refused again at once. Its words go out as the ordinary turn they would have been; the sandbox's
// kept turn runs as itself, as its press would run it.
// `sendKept` sends a turn the sandbox kept whole at the door, as the pass's own dispatch does.
export const releaseRoomHolds = async (services: Services, now: number, due: DueAt, sendKept: (held: HeldRecord) => Promise<void>): Promise<void> => {
    const holds = roomHolds(services);
    if (holds.length === 0) {
        return;
    }
    let next: RoomHold | undefined;
    for (const hold of holds) {
        // Room is not all it may wait for: on a spent account it waits for the reopen too, and the next hold gets the room.
        if (breakArmed(await breakPolicyFor(services, hold.conversationId, "memory")) && !(await waitsOnAllowance(services, hold, now))) {
            next = hold;
            break;
        }
    }
    if (next === undefined) {
        return;
    }
    const since = await services.resources.roomSince();
    // The settle window's end is a known instant; memory still short has none, so it is looked at again on the beat.
    if (since === undefined || now - since < ROOM_SETTLE_MS) {
        due(since === undefined ? now + ROOM_LOOK_MS : since + ROOM_SETTLE_MS);
        return;
    }
    const { conversationId } = next;
    services.logger.info({ conversationId, kind: next.kind, waitedMs: now - next.since }, "resume pass: memory freed up, a held message goes out");
    if (next.kind === "door") {
        await sendKept(next.held);
        return;
    }
    const ids = waitingOf(services.conversations.queued(conversationId)).map((item) => item.id);
    services.conversations.send(conversationId, { kind: "queue-released", ids }, now);
    await services.turns.drain(conversationId);
};
