import { goesBySelf, turnInFlight, watching } from "../../agent-status/agentStatus-standing";
import type { FleetAgent } from "../useAgents-fleet";

// WHAT AN ACTIVE CARD IS DOING, AS THE LANE GROUPS IT. Active holds three kinds of conversation that answer three
// different questions, and one sort across all of them (drafts, then turn start) interleaved them so a twenty-card lane
// read as no order at all: a draft over a running turn over a message booked for 3am over another running turn.
//  - working: a turn in flight, or a family lifted into Active by the children working under it (childFold). "What is
//    under way?" Newest started first, the order Attention and Finished read in, and fixed for a turn's life, so a
//    streaming card never climbs.
//  - next: nothing running, but it goes by itself (`next`: a booked message, a spent allowance's resend, a memory
//    hold, a land it waits on) or an armed watch wakes it. "What starts by itself, and when?" Soonest first, by the
//    instant its corner names, so the corners read as a timetable; what names no instant follows, newest first.
//  - draft: never sent. "What did I leave unwritten?" Last, as it moves nothing, newest first.
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
    // In Active by no reading of its own: its family's children are working under it (childFold lifts it here).
    return `working`;
};

// The soonest instant the card goes again by itself: a resend or booked message's own time, or the deadline a watch
// wakes it by at the latest. Infinity for what names none (a memory hold, a land it waits on).
export const goesAt = (agent: Pick<FleetAgent, "next" | "watches">): number => {
    const next = agent.next;
    const booked = next !== undefined && (next.kind === `rerun` || next.kind === `send`) ? next.at : Number.POSITIVE_INFINITY;
    return Math.min(booked, ...(agent.watches ?? []).map((watch) => watch.deadlineAt));
};

// The instant each phase sorts by within itself, newest first unless the phase says otherwise (see above).
const startedOf = (agent: FleetAgent): number => agent.startedAt ?? agent.updatedAt;
const draftedOf = (agent: FleetAgent): number => agent.draftAt ?? agent.updatedAt;

// Equal instants (a batch resumed together) fall back to the id, so two cards never swap places between frames.
const byId = (a: FleetAgent, b: FleetAgent): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const rank = (agent: FleetAgent): number => ACTIVE_PHASES.indexOf(activePhase(agent));

// The Active lane's one order, for the board and the chat rail alike: phase, then each phase's own clock.
export const activeLaneOrder = (a: FleetAgent, b: FleetAgent): number => {
    const phase = rank(a) - rank(b);
    if (phase !== 0) {
        return phase;
    }
    switch (activePhase(a)) {
        case `working`:
            return startedOf(b) - startedOf(a) || byId(a, b);
        case `next`:
            return compareAt(goesAt(a), goesAt(b)) || b.updatedAt - a.updatedAt || byId(a, b);
        case `draft`:
            return draftedOf(b) - draftedOf(a) || byId(a, b);
    }
};

// Ascending, with two "never" instants equal rather than NaN (Infinity - Infinity).
const compareAt = (a: number, b: number): number => (a === b ? 0 : a < b ? -1 : 1);

// The Active lane cut into its phases, in the lane's order, each keeping the order it came in.
export const activeGroups = <T extends PhaseFacts>(cards: readonly T[]): readonly { readonly phase: ActivePhase; readonly cards: T[] }[] =>
    ACTIVE_PHASES.map((phase) => ({ phase, cards: cards.filter((card) => activePhase(card) === phase) })).filter((group) => group.cards.length > 0);
