import { parentOfActor } from "../../../auth/principal.js";
import type { Services } from "../../../composition.js";
import type { ConversationActors } from "../../../conversations/actor/conversation-actors.js";
import { liveRunOf } from "../../../conversations/actor/conversation-holdings.js";
import { stopChildDiskRoomWait } from "../../run/placement/child-disk-room.js";
import { noSuchChild } from "../child-held.js";
import { CHILDREN, closeUnstarted, PERSON_RUNS, refundReservedSeat, SEAT_LINE, settleChild } from "../child-records.js";
import { CANCEL_NOTES, CANCELLED, cancelledWords, NOTHING_TO_CANCEL } from "../child-words.js";
import type { ChildActionResult, ChildParent, ChildRecord } from "../children.js";
import { FAN_OUT } from "../fan-out-governor.js";
import { endPause } from "../paused-children.js";
import { withdrawAfter } from "../starting/child-after.js";
import { stopRoomWait } from "../starting/child-room.js";
import { stopRunsOf } from "../workflows/live-runs.js";
import {
    type CancelMove,
    type ChildStanding,
    cancelMoveFor,
    descendantsOf,
    type FamilyCancel,
    type FamilyEnd,
    type FamilyLink,
    familyCancels,
    markFamilyEnded,
} from "./family-cancel.js";
import { haltConversation, type HaltedBy, liftHalt } from "../../../conversations/actor/conversation-halt.js";
import { type Quieted, quietHalted } from "./halt-quiet.js";

/* WHAT A CANCEL STOPS, AND WHO MAY ASK FOR IT. A cancel reaches the conversation it names and everything below it in the
   spawn tree, and any conversation above it may ask: the board draws a grandchild under its eldest ancestor's card, so an
   owner who tells that agent to stop its subagents means all of them. On 2026-11-24 an orchestrator told to stop all its
   subagents cancelled the six it had spawned, was refused "No such child" for the five those six had spawned, and woke
   the six again, one follow-up turn each, to have each cancel its own. Every conversation the cancel reaches is halted
   first (conversations/actor/conversation-halt.ts), so the turns it stops close without waiting on what they left running, and once they have stopped
   whatever could still wake them is taken away (halt-quiet.ts). What they wrote stays on their branches. */

// What a cancel reaches a child through: its conversation's actor, and the turn port's stop.
export interface ChildCancelDeps {
    readonly conversations: Pick<ConversationActors, "holdings" | "state" | "send" | "queued">;
    readonly turns: Pick<Services["turns"], "stop">;
}

/** What a cancel of a subtree reads and stops: the registry's spawn links, each child's conversation, and the turn port's stop. */
export interface FamilyDeps extends ChildCancelDeps {
    readonly agents: Pick<Services["agents"], "ids" | "entry">;
    readonly logger: Pick<Services["logger"], "info" | "warn">;
}

/** The id `cancel` takes for every child of the caller's at once, with everything below them. */
export const ALL_CHILDREN = "all";

// A start its parent cancelled before it ran: off the records, its row killed as the cancel's own ending.
export const endUnstarted = (services: Pick<ChildCancelDeps, "conversations">, id: string): void => {
    // Settled before the record goes, so a worker's ending is filed as its run's, not its parent's.
    settleChild(services.conversations, id, { status: "killed", report: "", error: CANCELLED });
    closeUnstarted(services.conversations, id);
};

// The cancel of one child this daemon supervises, whoever asked for it: an agent above it, or the end of its family.
const cancelRecord = async (services: ChildCancelDeps, childId: string, kid: ChildRecord): Promise<ChildActionResult> => {
    // Held by the governor, not by the owner: the parent may take it back, and it never starts. One already off its lane
    // is being started (holdOnLane), which sees the cancel; refused as "on the owner's card", it started anyway.
    if (kid.held === "lane") {
        const withdrawn = FAN_OUT.withdraw(childId);
        if (!withdrawn && !kid.running) {
            refundReservedSeat(services.conversations, kid.parent);
        }
        if (withdrawn || !kid.running) {
            endUnstarted(services, childId);
        }
        kid.cancelled = true;
        return { ok: true, note: CANCEL_NOTES.waiting };
    }
    // Waiting for a seat among its parent's children, or for its siblings: taken off the line, it never starts.
    if (kid.held === "seat" || kid.held === "after") {
        SEAT_LINE.withdraw(kid.parent, childId);
        withdrawAfter(childId);
        endUnstarted(services, childId);
        kid.cancelled = true;
        return { ok: true, note: CANCEL_NOTES.waiting };
    }
    if (kid.held !== undefined) {
        return { ok: false, message: "It waits on the owner's card, which is theirs to answer: it does not go unless they allow it." };
    }
    if (kid.paused !== undefined) {
        const { failure } = kid.paused;
        endPause(kid);
        const held = services.conversations.state(childId)?.resume.held;
        if (held !== undefined && !held.fired) {
            services.conversations.send(childId, { kind: "resume-dropped" });
        }
        settleChild(services.conversations, childId, { status: "killed", report: kid.report ?? "", error: `${failure} ${CANCELLED}` });
        // Its file is the only place the pause lives, and no turn follows to write over it: a boot would put it back.
        kid.persist?.();
        return { ok: true, note: CANCEL_NOTES.paused };
    }
    if (!kid.running) {
        return { ok: false, message: NOTHING_TO_CANCEL };
    }
    kid.cancelled = true;
    const run = liveRunOf(services.conversations, childId);
    // Still waiting for memory, or for a turn somebody else started on it: its start sees the cancel and does not happen.
    if (run === undefined || kid.queued || kid.behind) {
        stopRoomWait(childId);
        stopChildDiskRoomWait(childId);
        return { ok: true, note: CANCEL_NOTES.waiting };
    }
    await services.turns.stop({ conversationId: childId, run: run.id });
    return { ok: true, note: CANCEL_NOTES.running };
};

// A family as it stood while its heads were still on the board: every conversation below them, and the records of those
// this daemon supervises, which a head's dispose takes with it, since a child's record is held by its parent.
export interface Family {
    readonly heads: readonly string[];
    readonly members: readonly FamilyLink[];
    readonly records: ReadonlyMap<string, ChildRecord>;
}

// Every spawn link this daemon knows: its own records, and the registry's record of who started whom.
const spawnLinks = (deps: Pick<FamilyDeps, "agents" | "conversations">): FamilyLink[] => {
    const links: FamilyLink[] = deps.conversations
        .holdings(CHILDREN)
        .entries()
        .map(([child, kid]) => ({ child, parent: kid.parent }));
    for (const id of deps.agents.ids()) {
        const parent = parentOfActor(deps.agents.entry(id)?.identity.startedBy);
        if (parent !== undefined) {
            links.push({ child: id, parent });
        }
    }
    return links;
};

/**
 * The family below these conversations: the children they spawned, theirs, and so on, by the registry's record of who
 * started whom, which outlives a restart, and by this daemon's own records, which hold a child whose first turn has not
 * opened its conversation yet. Read before the heads are forgotten.
 */
export const familyOf = (deps: Pick<FamilyDeps, "agents" | "conversations">, heads: readonly string[]): Family => {
    if (heads.length === 0) {
        return { heads, members: [], records: new Map() };
    }
    const kids = deps.conversations.holdings(CHILDREN);
    const members = descendantsOf(heads, spawnLinks(deps));
    const records = new Map<string, ChildRecord>();
    for (const { child } of members) {
        const kid = kids.get(child);
        if (kid !== undefined) {
            records.set(child, kid);
        }
    }
    return { heads, members, records };
};

// The conversation that spawned this one, by this daemon's record, else the registry's.
const parentLinkOf = (deps: Pick<FamilyDeps, "agents" | "conversations">, id: string): string | undefined =>
    deps.conversations.holdings(CHILDREN).get(id)?.parent ?? parentOfActor(deps.agents.entry(id)?.identity.startedBy);

/** Whether `id` sits anywhere below `ancestor` in the spawn tree; walked up with the path it came by, so a loop ends it. */
export const descendsFrom = (deps: Pick<FamilyDeps, "agents" | "conversations">, id: string, ancestor: string): boolean => {
    const seen = new Set<string>([id]);
    for (let at = parentLinkOf(deps, id); at !== undefined && !seen.has(at); at = parentLinkOf(deps, at)) {
        if (at === ancestor) {
            return true;
        }
        seen.add(at);
    }
    return false;
};

// How a member stands as the cancel runs: off its record where this daemon supervises it, else off its conversation.
const standingOf = (deps: ChildCancelDeps, family: Family, child: string): ChildStanding => {
    const kid = family.records.get(child) ?? deps.conversations.holdings(CHILDREN).get(child);
    if (kid !== undefined) {
        // Only a card is the owner's to answer; a start held on its lane or waiting for a seat is the sandbox's to withdraw.
        return { tracked: true, heldForOwner: kid.held === "start" || kid.held === "message", paused: kid.paused !== undefined, running: kid.running };
    }
    const run = liveRunOf(deps.conversations, child);
    const held = deps.conversations.state(child)?.resume.held;
    return {
        tracked: false,
        sandboxRun: run !== undefined && deps.conversations.holdings(PERSON_RUNS).get(child) !== run.id,
        bookedRerun: held !== undefined && !held.fired && held.input.speaker?.kind !== "person",
    };
};

// A move that stops something: the cancel tool's own path, or a live turn and a booking directly.
type StopMove = Extract<CancelMove, { readonly kind: "cancel" | "halt" }>;

// Stops one member as its move says: the cancel tool's own path, or its live turn and its booking directly.
const stopMember = async (deps: ChildCancelDeps, family: Family, child: string, move: StopMove): Promise<void> => {
    if (move.kind === "cancel") {
        const kid = family.records.get(child) ?? deps.conversations.holdings(CHILDREN).get(child);
        if (kid !== undefined) {
            await cancelRecord(deps, child, kid);
        }
        return;
    }
    if (move.drop) {
        deps.conversations.send(child, { kind: "resume-dropped" });
    }
    const run = move.stop ? liveRunOf(deps.conversations, child) : undefined;
    if (run !== undefined) {
        await deps.turns.stop({ conversationId: child, run: run.id });
    }
};

// Whether quieting found anything that would have woken it.
const tookAnything = (quieted: Quieted): boolean => quieted.jobs + quieted.watches + quieted.words > 0 || quieted.rerun;

// Who a family's end is said to have come from: a person's press, or an agent's cancel.
const haltedByOf = (why: FamilyEnd): HaltedBy => (why === "cancelled" ? "agent" : "person");

/**
 * Cancels the family below these heads: every running turn, waiting start and booked re-run of the children they
 * spawned, and of theirs, as each one's parent would cancel it, and everything that could wake one of them by itself
 * afterwards (halt-quiet.ts). Their conversations and what they wrote stay. Run by a conversation leaving the board once
 * its heads are filed away or forgotten, so a stopped child's ending is said to nobody and its work lands as any
 * conversation's does, never into a checkout on its way out; by a person's Stop all (family-stop.ts); and by an agent's
 * cancel for what sits below the conversation it named. A child with children of its own is marked first, so the endings
 * stopped under it do not wake it into a turn. The children stop side by side, since a stop waits for its turn to unwind.
 * Never throws; answers each member it stopped or took a wake away from.
 */
export const cancelFamily = async (deps: FamilyDeps, family: Family, why: FamilyEnd): Promise<readonly FamilyCancel[]> => {
    // Its workflow runs first, so none starts a worker in place of one stopped below (live-runs.ts).
    stopRunsOf([...family.heads, ...family.members.map(({ child }) => child)], why === "stopped" ? "owner" : why === "cancelled" ? "agent" : "left");
    if (family.members.length === 0) {
        return [];
    }
    const by = haltedByOf(why);
    const cancels = familyCancels(family.members, (child) => standingOf(deps, family, child));
    const heads = new Set(family.heads);
    for (const { parent } of cancels) {
        if (!heads.has(parent)) {
            markFamilyEnded(deps.conversations, parent, Date.now());
        }
    }
    // Before any stop, so each stopped turn's own close stops what it left running instead of waiting on it.
    for (const { child } of family.members) {
        if (!leftAlone(deps, family, child)) {
            haltConversation(deps.conversations, child, by);
        }
    }
    const stopped = await Promise.all(
        cancels.map(async (cancel) => {
            try {
                if (cancel.move.kind !== "quiet") {
                    await stopMember(deps, family, cancel.child, cancel.move);
                }
                return [cancel];
            } catch (error) {
                deps.logger.warn({ err: error, child: cancel.child, parent: cancel.parent, why }, "subagents: a child below a cancel could not be stopped");
                return [];
            }
        }),
    );
    const done = stopped.flat();
    const quietOnly = await quietMembers(deps, family, new Set(done.map(({ child }) => child)), by);
    const all = [...done, ...quietOnly];
    if (all.length > 0) {
        deps.logger.info(
            { why, heads: family.heads, cancelled: all.map(({ child, parent, move }) => ({ child, parent, ...move })) },
            "subagents: cancelled the family below a cancel or a conversation that left the board",
        );
    }
    return all;
};

// Whether a member is the person's or the owner's for now, which a family's cancel leaves be: its start or message waits on
// the owner's card, or the turn running in its chat, or the one booked to run again, is a person's own.
const leftAlone = (deps: ChildCancelDeps, family: Family, child: string): boolean => {
    const standing = standingOf(deps, family, child);
    if (standing.tracked) {
        return standing.heldForOwner;
    }
    const run = liveRunOf(deps.conversations, child);
    const held = deps.conversations.state(child)?.resume.held;
    return (run !== undefined && !standing.sandboxRun) || (held !== undefined && !held.fired && !standing.bookedRerun);
};

// Takes away what could wake each member by itself, once their turns have stopped. A member the cancel stopped nothing of
// and took nothing from is let go of the halt: it had nothing going, and its record stays as it was. Answers the members
// only the quieting reached, as moves of their own.
const quietMembers = async (deps: FamilyDeps, family: Family, stopped: ReadonlySet<string>, by: HaltedBy): Promise<FamilyCancel[]> => {
    const reached = await Promise.all(
        family.members.map(async (member): Promise<FamilyCancel[]> => {
            if (leftAlone(deps, family, member.child)) {
                return [];
            }
            const quieted = await quietHalted(deps, member.child, by);
            if (stopped.has(member.child)) {
                return [];
            }
            if (!tookAnything(quieted)) {
                liftHalt(deps.conversations, member.child);
                return [];
            }
            return [{ ...member, move: { kind: "quiet" } }];
        }),
    );
    return reached.flat();
};

/**
 * Stops a conversation below this parent, and everything below it: its running turn, the start it waits on memory or
 * another turn for, or the re-run the sandbox booked for it, then the same for every subagent it started and theirs, and
 * whatever would wake any of them by itself. Any conversation below the caller may be named, not only one it spawned.
 * `all` names every child of the caller's at once. A start or message still waiting on the owner's card is theirs to
 * decline, not the parent's to withdraw.
 */
export const cancelChild = async (services: FamilyDeps, parent: ChildParent, childId: string): Promise<ChildActionResult> => {
    if (childId === ALL_CHILDREN) {
        return cancelAllChildren(services, parent);
    }
    if (!descendsFrom(services, childId, parent.conversationId)) {
        return noSuchChild(services, parent, childId);
    }
    return cancelSubtree(services, childId, "agent");
};

// One conversation and the subtree below it, stopped as one.
const cancelSubtree = async (services: FamilyDeps, childId: string, by: HaltedBy): Promise<ChildActionResult> => {
    const below = familyOf(services, [childId]);
    const kid = services.conversations.holdings(CHILDREN).get(childId);
    const onCard = kid?.held === "start" || kid?.held === "message";
    if (!onCard) {
        haltConversation(services.conversations, childId, by);
    }
    const own = kid === undefined ? await cancelUntracked(services, childId) : await cancelRecord(services, childId, kid);
    const stopped = await cancelFamily(services, below, by === "agent" ? "cancelled" : "stopped");
    const quieted = onCard ? undefined : await quietHalted(services, childId, by);
    const answer = cancelAnswer(own, stopped.length, quieted);
    if (!answer.ok && !onCard) {
        liftHalt(services.conversations, childId);
    }
    return answer;
};

// A conversation below the caller this daemon keeps no record of (one a restart lost track of): the sandbox's own turn on
// it stopped and its booked re-run dropped, as a family's end does for such a member.
const cancelUntracked = async (services: FamilyDeps, childId: string): Promise<ChildActionResult> => {
    const move = cancelMoveFor(standingOf(services, { heads: [], members: [], records: new Map() }, childId));
    if (move.kind !== "halt") {
        return { ok: false, message: NOTHING_TO_CANCEL };
    }
    await stopMember(services, { heads: [], members: [], records: new Map() }, childId, move);
    return { ok: true, note: CANCEL_NOTES.running };
};

// What the caller reads: its own cancel's answer, with what went below it and what would have woken it. A child whose own
// turn had ended is still cancelled where something below it ran or something would have woken it.
const cancelAnswer = (own: ChildActionResult, below: number, quieted: Quieted | undefined): ChildActionResult => {
    const woke = quieted !== undefined && tookAnything(quieted);
    if (!own.ok && own.message !== NOTHING_TO_CANCEL) {
        return below === 0 ? own : { ok: false, message: `${own.message} ${cancelledWords(below, undefined)}` };
    }
    if (!own.ok && below === 0 && !woke) {
        return own;
    }
    const lead = own.ok ? (own.note ?? "") : CANCEL_NOTES.idle;
    return { ok: true, note: `${lead} ${cancelledWords(below, woke ? quieted : undefined)}`.trim() };
};

// Every child of the caller's, and everything below each.
const cancelAllChildren = async (services: FamilyDeps, parent: ChildParent): Promise<ChildActionResult> => {
    const children = descendantsOf([parent.conversationId], spawnLinks(services)).filter((link) => link.parent === parent.conversationId);
    const answers = await Promise.all(children.map(({ child }) => cancelSubtree(services, child, "agent")));
    const cancelled = answers.filter((answer) => answer.ok).length;
    if (cancelled === 0) {
        return { ok: false, message: "None of your subagents, nor any below them, is running, waiting, booked to run or waiting on a wake: there is nothing to cancel." };
    }
    return {
        ok: true,
        note: `Cancelled ${cancelled} of your ${children.length} subagents, with everything below them. Each stays stopped until you or a person send it a message; what each wrote stays on its own branch (merge brings one into your checkout).`,
    };
};
