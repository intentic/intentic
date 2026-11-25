import { conversationProfile } from "../../../conversations/registry/agents-store.js";
import type { Services } from "../../../composition.js";
import { deliverWake } from "../../../seams/wake-delivery.js";
import type { WorkPlace } from "../../../workload/resource-budget.js";
import { fairOrder } from "../../../workload/room-wait-queue.js";
import type { ChildRecord } from "../children.js";
import { taskLine } from "../child-spec.js";
import { NOT_STARTED } from "../child-words.js";
import { markSubagentEndingReported, noteSpawnedChild, subagentEndingReported } from "../subagents.js";

/* A CHILD THAT CANNOT GET ROOM WAITS FOR IT, IN LINE, AND STARTS BY ITSELF. A child's turn is admitted to the box before
   it starts (children.ts), and work nobody waits on was held for room ten minutes and then turned away: "waited 10
   minutes for room and did not start: work people send gets the room first", which `wait` handed its parent as the
   child's failed ending. In the shinobi-society audit (2026-11-17) that happened at least seven times, one child four
   times in a row, on a laptop whose other sandboxes held its memory: waiting ten minutes could not change that, and each
   parent re-spawned, re-briefed or did the slice itself. A child now waits as long as ROOM_CEILING_MS, its row pending
   and saying why, since when and where it stands among the children waiting for room; it starts as soon as the box has
   room, and only past the ceiling does it end, unstarted with nothing spent, its parent woken to say so. Work people send
   still goes first: the gate keeps a person's turn's worth of room free of anything nobody waits on (memory-room.mjs). */

/** How long a child waits for room before it ends unstarted: the horizon a child refused for a spent allowance keeps by
 *  default (settings `childRerunHorizonHours`), long enough to outlast another sandbox's afternoon of builds. */
export const ROOM_CEILING_MS = 6 * 3_600_000;

// The children waiting for room now, in the order they began to, sandbox-wide; each says where it stands on its row,
// counted as the gate takes them: its parent's children take turns with every other parent's (room-wait-queue.ts).
interface Waiting {
    readonly childId: string;
    readonly parent: string | undefined;
    readonly since: number;
    readonly diagnosis: string;
    readonly note: (summary: string) => void;
}
const LINE: Waiting[] = [];
// What stops each child's wait: its parent's cancel, or its family's as its parent leaves.
const STOPS = new Map<string, AbortController>();

const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"] as const;
const ordinal = (position: number): string => ORDINALS[position - 1] ?? `number ${String(position)}`;
const clock = (at: number): string => new Date(at).toISOString().slice(11, 16);
const hours = (ms: number): string => `${String(Math.round(ms / 3_600_000))} hours`;

// A waiting child's row summary: why it waits, since when, where it stands, and that it starts by itself.
const roomLineWords = (waiting: Pick<Waiting, "since" | "diagnosis">, position: number, count: number): string =>
    `Waiting for memory since ${clock(waiting.since)} UTC${count > 1 ? `, ${ordinal(position)} of ${String(count)} subagents waiting for room` : ""}: ${waiting.diagnosis}. ` +
    `It starts by itself as soon as there is room (it gives up after ${hours(ROOM_CEILING_MS)}); nothing is spent while it waits, and work people send gets the room first.`;

// Every waiting child's row, told where it stands now.
const renote = (): void => {
    for (const [index, waiting] of fairOrder(LINE, (entry) => entry.parent).entries()) {
        waiting.note(roomLineWords(waiting, index + 1, LINE.length));
    }
};

const leave = (childId: string): void => {
    const index = LINE.findIndex((waiting) => waiting.childId === childId);
    if (index >= 0) {
        LINE.splice(index, 1);
        renote();
    }
};

/** Stops a child's wait for room, so a cancelled child leaves the line at once rather than when room comes. */
export const stopRoomWait = (childId: string): void => STOPS.get(childId)?.abort();

export const resetRoomLineForTest = (): void => {
    LINE.length = 0;
    STOPS.clear();
};

// Why a child that waited out the ceiling did not start, as its row and its parent read it.
const ceilingWords = (waitedMs: number, diagnosis: string): string =>
    `Not started: it waited ${hours(waitedMs)} for memory and there was still no room (${diagnosis}). Nothing was spent on it, and its task is kept: ` +
    "send it a message once there is room and it starts from its task, or cancel it.";

/** Why a child's turn was not admitted: its words, and whether its parent must be woken to hear them (the ceiling). */
export interface RoomRefusal {
    readonly refused: string;
    readonly ceiling: boolean;
}

/**
 * Admits one child turn to the box: undefined once there is room, else why there is none. Admitted here, where the wait
 * can be shown on the child's row, and kept for the door, which takes this admission instead of judging the same turn a
 * second time. A child placed on a runner holds nothing here.
 */
export const admitChildRoom = async (
    services: Pick<Services, "conversations" | "resources">,
    childId: string,
    kid: ChildRecord | undefined,
    where: WorkPlace,
): Promise<RoomRefusal | undefined> => {
    if (kid !== undefined) {
        kid.queued = true;
    }
    const stop = new AbortController();
    STOPS.set(childId, stop);
    const onShort = (diagnosis: string): void => {
        LINE.push({
            childId,
            parent: kid?.parent,
            since: Date.now(),
            diagnosis,
            note: (summary) => noteSpawnedChild(services.conversations, childId, { status: "pending", summary }),
        });
        renote();
    };
    try {
        const room = await services.resources.admit({
            workload: "agentRuntime",
            attended: false,
            owner: childId,
            where,
            forTurn: true,
            group: kid?.parent,
            wait: { onShort, deadlineMs: ROOM_CEILING_MS, signal: stop.signal },
        });
        if (room.verdict === "run") {
            if (room.waitedMs > 0) {
                noteSpawnedChild(services.conversations, childId, { status: "running", summary: "" });
            }
            return undefined;
        }
        if (stop.signal.aborted) {
            return { refused: NOT_STARTED.cancelled, ceiling: false };
        }
        const diagnosis = room.verdict === "refuse" ? (room.diagnosis ?? room.message) : room.message;
        return { refused: ceilingWords(room.waitedMs, diagnosis), ceiling: true };
    } finally {
        if (kid !== undefined) {
            kid.queued = false;
        }
        if (STOPS.get(childId) === stop) {
            STOPS.delete(childId);
        }
        leave(childId);
    }
};

/**
 * Wakes a child's parent with the ending of a child that never started (the ceiling passed), unless a wait of the
 * parent's already took it: an unstarted child has no run, so no report of its own reaches the parent. Never throws.
 */
export const wakeParentUnstarted = async (
    services: Pick<Services, "agents" | "conversations" | "turns" | "logger">,
    childId: string,
    kid: Pick<ChildRecord, "parent" | "spec">,
    refused: string,
): Promise<void> => {
    const entry = services.agents.entry(kid.parent);
    if (subagentEndingReported(services.conversations, childId) || entry === undefined || entry.archivedAt !== undefined) {
        return;
    }
    try {
        const receipt = await deliverWake(
            { turns: services.turns },
            {
                conversationId: kid.parent,
                prompt: `Your subagent \`${childId}\` ("${taskLine(kid.spec)}") did not start. ${refused}`,
                voice: "sandbox",
                source: "subagents",
                profile: conversationProfile(entry),
            },
        );
        if (!("invalid" in receipt) && !("why" in receipt)) {
            markSubagentEndingReported(services.conversations, childId);
        }
    } catch (error) {
        services.logger.warn({ err: error, child: childId }, "child room: its parent could not be told it never started");
    }
};
