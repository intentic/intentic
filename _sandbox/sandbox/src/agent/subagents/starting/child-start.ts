import { within } from "@intentic/base/async";
import type { Services } from "../../../composition.js";
import { liveRunOf } from "../../../conversations/actor/conversation-holdings.js";
import type { TurnInput } from "../../../seams/turn-starter.js";
import type { WorkPlace } from "../../../workload/resource-budget.js";
import type { ChildRecord, ChildTurnTally } from "../children.js";
import { spentAsked } from "../child-listing.js";
import { CHILDREN } from "../child-records.js";
import { admitChildRoom } from "./child-room.js";
import { BEHIND_MAX_MS, NOT_STARTED } from "../child-words.js";
import { noteSpawnedChild } from "../subagents.js";

// How one child turn gets under way once its parent's seat is taken (children.ts runChildTurn): room on the box first
// (child-room.ts), the records asked again after a long wait, and the turn started once no other turn holds its
// conversation, waiting that turn out where one does.

// What the roster row says while a follow-up waits behind a turn somebody else started on the child.
const BEHIND_SUMMARY = "Waiting for the turn already running on it to end; your message runs right after.";
// How many times a follow-up waits out another turn before it gives up: a turn that ends can be followed at once by
// what waited in the conversation's own queue.
const BEHIND_TRIES = 3;

export type StartedChildTurn = Exclude<ReturnType<Services["turns"]["run"]>, string>;

// Starts the child's turn at once, so it is followed from its first frame, and journalled, so it survives a container
// recreate the way every turn the daemon starts does: its parent keeps waiting on it across one, and at the next boot it
// resumes and its report still reaches that parent (child-report.ts reads the parent off the registry).
const startChildTurn = (services: Services, turn: TurnInput & { conversationId: string }): ReturnType<Services["turns"]["run"]> =>
    services.turns.run(turn, { journalled: true });

// Waits out the turn holding the child's conversation, once: whether it ended in time.
const outlast = async (services: Services, childId: string, kid: ChildRecord | undefined): Promise<boolean> => {
    const other = liveRunOf(services.conversations, childId);
    if (kid !== undefined) {
        kid.behind = true;
    }
    noteSpawnedChild(services.conversations, childId, { status: "pending", summary: BEHIND_SUMMARY });
    const ended = await within((other?.waitUntilFinished() ?? Promise.resolve()).then(() => true), BEHIND_MAX_MS, false, { unref: true });
    if (kid !== undefined) {
        kid.behind = false;
    }
    return ended;
};

// Another turn can hold the child's conversation when this one's comes: a person writing in its own chat, the land
// conflict the owner sent it, a turn resumed after an allowance refused it. The parent's words wait for that turn to end
// rather than being dropped.
// The room admitted for the turn is held only briefly (resource-budget.ts), so a turn that waited behind another one asks
// for room again before it starts: otherwise the door judges it afresh with its run already held, and the child reads as
// working with nothing running for as long as that second wait lasts.
const startWhenFree = async (
    services: Services,
    childId: string,
    kid: ChildRecord | undefined,
    turn: TurnInput & { conversationId: string },
    readmit: () => Promise<string | undefined>,
): Promise<{ readonly started: StartedChildTurn } | { readonly refused: string }> => {
    let run = startChildTurn(services, turn);
    let tries = 0;
    for (; run === "busy" && tries < BEHIND_TRIES; tries += 1) {
        if (!(await outlast(services, childId, kid))) {
            return { refused: NOT_STARTED.stuck };
        }
        const short = await readmit();
        if (short !== undefined) {
            return { refused: short };
        }
        if (kid?.cancelled === true) {
            return { refused: NOT_STARTED.cancelled };
        }
        run = startChildTurn(services, turn);
    }
    if (run === "busy" || run === "archived") {
        return { refused: NOT_STARTED[run] };
    }
    if (tries > 0) {
        noteSpawnedChild(services.conversations, childId, { status: "running", summary: "" });
    }
    return { started: run };
};

// How long a wait for memory may run before the records are asked again whether the child's model is still askable.
const STALE_ADMISSION_MS = 30_000;

// Admits one child turn to the box and starts it once its conversation is free, or says in the tally why it did not.
export const admitAndStart = async (
    services: Services,
    childId: string,
    kid: ChildRecord | undefined,
    turn: TurnInput & { conversationId: string },
    where: WorkPlace,
    tally: ChildTurnTally,
): Promise<StartedChildTurn | undefined> => {
    const queuedAt = Date.now();
    const short = await admitChildRoom(services, childId, kid, where);
    if (short !== undefined) {
        tally.failure = short.refused;
        tally.ceiling = short.ceiling;
        return undefined;
    }
    // Cancelled while it waited, or its record gone with a parent disposed meanwhile, which starting it would bring back.
    if (kid?.cancelled === true || (kid !== undefined && services.conversations.holdings(CHILDREN).get(childId) !== kid)) {
        tally.failure = NOT_STARTED.cancelled;
        return undefined;
    }
    // A start that waited for memory is asked of the records again: what was askable when it queued may be spent now.
    const spent = Date.now() - queuedAt < STALE_ADMISSION_MS || kid === undefined ? undefined : await spentAsked(services, kid.spec);
    if (spent !== undefined) {
        tally.failure = `Not started after waiting for memory, and nothing spent on it: ${spent}`;
        return undefined;
    }
    if (kid !== undefined) {
        kid.oomKillsAtStart = (await services.resources.snapshot(0)).reading.oomKills;
    }
    // The parent's agent asked for it, never a person.
    const start = await startWhenFree(services, childId, kid, turn, async () => (await admitChildRoom(services, childId, kid, where))?.refused);
    if ("refused" in start) {
        tally.failure = start.refused;
        return undefined;
    }
    return start.started;
};
