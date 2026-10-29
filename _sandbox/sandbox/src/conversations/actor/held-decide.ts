import { handoffAvailable } from "@intentic/sandbox-contract/schemas/providers/handoff";
import { opt } from "../../opt.js";
import type { ConversationEvent, Decision } from "./conversation-decide.js";
import type { ConversationState, HeldRecord } from "./conversation-state.js";
import { BROADCAST, unchanged, withResume } from "./decision-parts.js";

// How a conversation's holds move by their own events. A held turn once it is held: a person's pick of an account
// re-points it, the resume pass times one refused with no instant and reads the wall in front of it, and a person picks
// how it continues. The hold on an idle conversation's prompt cache (cache-keepwarm.ts): armed, refreshed, ended.

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

// A live hold keeps its start and its count when re-armed; an ended one starts over.
export const onKeepWarmArmed = (state: ConversationState, until: number, now: number): Decision<undefined> => {
    const live = state.keepWarm?.ended === undefined ? state.keepWarm : undefined;
    return {
        state: { ...state, keepWarm: { since: live?.since ?? now, until, refreshes: live?.refreshes ?? 0, ...opt("readTokens", live?.readTokens) } },
        effects: BROADCAST,
        reply: undefined,
    };
};

// A refresh or an ending that lands after a turn took the hold has nothing left to write to.
export const onKeepWarmRefreshed = (
    state: ConversationState,
    event: Extract<ConversationEvent, { kind: "keep-warm-refreshed" }>,
): Decision<undefined> => {
    const kept = state.keepWarm;
    if (kept === undefined || kept.ended !== undefined || state.phase.kind === "running") {
        return unchanged(state, undefined);
    }
    return {
        state: {
            ...state,
            turn: { ...state.turn, promptCache: { at: event.at, ttlMs: event.ttlMs } },
            keepWarm: { ...kept, refreshes: kept.refreshes + 1, readTokens: event.readTokens },
        },
        effects: BROADCAST,
        reply: undefined,
    };
};

export const onKeepWarmEnded = (
    state: ConversationState,
    event: Extract<ConversationEvent, { kind: "keep-warm-ended" }>,
    now: number,
): Decision<undefined> => {
    const kept = state.keepWarm;
    if (event.reason === undefined) {
        return kept === undefined ? unchanged(state, undefined) : { state: { ...state, keepWarm: undefined }, effects: BROADCAST, reply: undefined };
    }
    if (kept === undefined || kept.ended !== undefined) {
        return unchanged(state, undefined);
    }
    return {
        state: { ...state, keepWarm: { ...kept, ended: { at: now, reason: event.reason, ...opt("detail", event.detail) } } },
        effects: BROADCAST,
        reply: undefined,
    };
};
