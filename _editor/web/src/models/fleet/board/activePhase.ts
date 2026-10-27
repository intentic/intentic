import { goesBySelf, turnInFlight, watching } from "../../agent-status/agentStatus-standing";
import type { FleetAgent } from "../useAgents-fleet";

// WHAT AN ACTIVE CARD IS DOING, AS THE LANE GROUPS IT. Active holds three kinds of conversation that answer three
// different questions, and one sort across all of them (drafts, then turn start) interleaved them so a twenty-card lane
// read as no order at all: a draft over a running turn over a message booked for 3am over another running turn.
//  - working: a turn in flight, or a family lifted into Active by a child working under it (childFold). "What is
//    under way?" Newest started first, the order Attention and Finished read in, and fixed for a turn's life, so a
//    streaming card never climbs.
//  - next: nothing running, but it goes by itself (`next`: a booked message, a spent allowance's resend, a memory
//    hold, a land it waits on) or an armed watch wakes it. "What starts by itself, and when?" Read as a timetable, by
//    how soon it goes rather than by whether it names a time: first what goes any moment (a memory hold, a booked
//    instant already past), the longest waiting first; then what goes at a time, soonest first; last what waits on
//    another conversation landing, which nobody can put a time on, newest first. A memory hold sorted with the untimed
//    used to sit under a message booked for 3am, though it usually goes within the minute (2026-10-27).
//  - draft: never sent. "What did I leave unwritten?" Last, as it moves nothing, newest first.
// A card standing in Active for its family reads as the most urgent work in it (familyReading): a parent waiting on a
// child held for a spent allowance goes in Up next at the child's re-run, not in Working, where its own idle standing
// used to drop it by default though nothing in the family was running (2026-10-27).
export type ActivePhase = `working` | `next` | `draft`;

export const ACTIVE_PHASES: readonly ActivePhase[] = [`working`, `next`, `draft`];

type PhaseFacts = Pick<FleetAgent, "status" | "attention" | "next" | "awaitingWake" | "watches">;

export const activePhase = (agent: PhaseFacts): ActivePhase => {
    if (agent.status === `draft`) {
        return `draft`;
    }
    if (turnInFlight(agent)) {
        return `working`;
    }
    if (goesBySelf(agent) || watching(agent)) {
        return `next`;
    }
    // In Active by no reading of its own: a child stopped under it that its parent has not taken in yet (childFold lifts
    // the parent for it), which the parent is still supervising.
    return `working`;
};

// An instant already past, which is how the contract writes "any moment now" (AgentNext's `at`): a memory hold goes
// as soon as memory stays free, so it sorts ahead of every time, and a folded head reads it as due now.
export const ANY_MOMENT = 0;

// The soonest instant the card goes again by itself: a resend or booked message's own time, ANY_MOMENT for a memory
// hold, or the deadline a watch wakes it by at the latest. Infinity for a land it waits on, which no clock answers.
export const goesAt = (agent: Pick<FleetAgent, "next" | "watches">): number => {
    const next = agent.next;
    const own =
        next?.kind === `room` ? ANY_MOMENT : next !== undefined && (next.kind === `rerun` || next.kind === `send`) ? next.at : Number.POSITIVE_INFINITY;
    return Math.min(own, ...(agent.watches ?? []).map((watch) => watch.deadlineAt));
};

// HOW A CARD READS IN ACTIVE: its phase, and the clock each phase sorts by. `startedAt` is the earliest turn in flight
// it stands for and `goesAt` the soonest instant it goes by itself, each Infinity where nothing it stands for has one, so
// two readings join by taking the smaller of each.
export interface ActiveReading {
    readonly phase: ActivePhase;
    readonly startedAt: number;
    readonly goesAt: number;
}

const startedOf = (agent: FleetAgent): number => agent.startedAt ?? agent.updatedAt;
const draftedOf = (agent: FleetAgent): number => agent.draftAt ?? agent.updatedAt;

// A card read by its own facts alone.
export const ownReading = (agent: FleetAgent): ActiveReading => {
    const phase = activePhase(agent);
    return {
        phase,
        startedAt: phase === `working` ? startedOf(agent) : Number.POSITIVE_INFINITY,
        goesAt: phase === `next` ? goesAt(agent) : Number.POSITIVE_INFINITY,
    };
};

const rank = (phase: ActivePhase): number => ACTIVE_PHASES.indexOf(phase);

// A family's reading once one more of it is read in: the most urgent phase anywhere in it, so a family with a child
// working is working whatever else waits in it, and one whose work all waits to go by itself is up next.
export const joinReadings = (family: ActiveReading | undefined, member: ActiveReading): ActiveReading =>
    family === undefined
        ? member
        : {
              phase: rank(member.phase) < rank(family.phase) ? member.phase : family.phase,
              startedAt: Math.min(family.startedAt, member.startedAt),
              goesAt: Math.min(family.goesAt, member.goesAt),
          };

// Equal instants (a batch resumed together) fall back to the id, so two cards never swap places between frames.
const byId = (a: FleetAgent, b: FleetAgent): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// The Active lane's order, given how each card reads there: phase, then each phase's own clock.
export const activeOrderBy =
    (readingOf: (agent: FleetAgent) => ActiveReading) =>
    (a: FleetAgent, b: FleetAgent): number => {
        const left = readingOf(a);
        const right = readingOf(b);
        const phase = rank(left.phase) - rank(right.phase);
        if (phase !== 0) {
            return phase;
        }
        switch (left.phase) {
            case `working`:
                return right.startedAt - left.startedAt || byId(a, b);
            case `next`: {
                // Two memory holds go in the order they were held, so the longest waiting reads first; anything else that
                // shares an instant (two lands awaited, a batch booked together) reads newest first, as the other lanes do.
                const held = left.goesAt === ANY_MOMENT ? a.updatedAt - b.updatedAt : b.updatedAt - a.updatedAt;
                return compareAt(left.goesAt, right.goesAt) || held || byId(a, b);
            }
            case `draft`:
                return draftedOf(b) - draftedOf(a) || byId(a, b);
        }
    };

// The Active lane's one order by every card's own facts, for the store and the chat rail alike; the board re-reads the
// cards that stand for a family (childFold).
export const activeLaneOrder = activeOrderBy(ownReading);

// Ascending, with two "never" instants equal rather than NaN (Infinity - Infinity).
const compareAt = (a: number, b: number): number => (a === b ? 0 : a < b ? -1 : 1);

// The Active lane cut into its phases, in the lane's order, each keeping the order it came in.
export const activeGroups = <T extends PhaseFacts>(
    cards: readonly T[],
    phaseOf: (card: T) => ActivePhase = activePhase,
): readonly { readonly phase: ActivePhase; readonly cards: T[] }[] =>
    ACTIVE_PHASES.map((phase) => ({ phase, cards: cards.filter((card) => phaseOf(card) === phase) })).filter((group) => group.cards.length > 0);
