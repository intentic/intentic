import { handoffAvailable } from "@intentic/sandbox-contract/schemas/providers/handoff";
import { opt } from "../../opt.js";
import type { ConversationEvent, Decision } from "./conversation-decide.js";
import type { ConversationState, HeldRecord } from "./conversation-state.js";
import { BROADCAST, unchanged, withResume } from "./decision-parts.js";

// How a held turn's own events move it once it is held: a person's pick of an account re-points it, the resume pass
// times one refused with no instant and reads the wall in front of it, and a person picks how it continues.

// Only an unfired limit hold is re-timed: every other wall is not about which account pays. A pick undoes a booked move,
// since the person has just said where it goes.
export const onHeldRepointed = (state: ConversationState, event: Extract<ConversationEvent, { kind: "held-repointed" }>): Decision<boolean> => {
    const { held } = state.resume;
    if (held === undefined || held.fired || held.reason !== "limit") {
        return unchanged(state, false);
    }
    const { reopensAt: _old, ...rest } = held;
    const repointed: HeldRecord = {
        ...rest,
        ...opt("reopensAt", event.reopensAt),
        onto: { account: event.account, carry: event.carry },
        move: undefined,
    };
    return unchanged(withResume(state, { held: repointed }), true);
};

// Only an unfired limit hold with no instant and no move takes it: a pick or a refusal that timed it meanwhile stands.
// Told to every window, whose card now says when it goes.
export const onHeldRetimed = (state: ConversationState, reopensAt: number): Decision<boolean> => {
    const { held } = state.resume;
    if (held === undefined || held.fired || held.reason !== "limit" || held.reopensAt !== undefined || held.move !== undefined) {
        return unchanged(state, false);
    }
    return { state: withResume(state, { held: { ...held, reopensAt } }), effects: BROADCAST, reply: true };
};

// The wall the pass read in front of where an unfired limit hold goes; told to every window only when it moved, since the
// card's `next` waits behind it (limit-booking.ts).
export const onHeldWalled = (state: ConversationState, until: number | undefined): Decision<undefined> => {
    const { held } = state.resume;
    if (held === undefined || held.fired || held.reason !== "limit" || held.walledUntil === until) {
        return unchanged(state, undefined);
    }
    const { walledUntil: _was, ...rest } = held;
    return { state: withResume(state, { held: { ...rest, ...opt("walledUntil", until) } }), effects: BROADCAST, reply: undefined };
};

// Only an unfired limit hold whose offer names that way on takes the pick; told to every window, whose card shows it.
export const onHandoffChosen = (state: ConversationState, event: Extract<ConversationEvent, { kind: "handoff-chosen" }>): Decision<boolean> => {
    const { held } = state.resume;
    if (held === undefined || held.fired || held.reason !== "limit" || held.handoff === undefined || !handoffAvailable(held.handoff, event.handoff)) {
        return unchanged(state, false);
    }
    return { state: withResume(state, { held: { ...held, handoff: { ...held.handoff, chosen: event.handoff } } }), effects: BROADCAST, reply: true };
};
