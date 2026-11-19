import { handoffAvailable } from "@intentic/sandbox-contract/schemas/providers/handoff";
import { opt } from "../../opt.js";
import type { ConversationEvent, Decision } from "./conversation-decide.js";
import type { ConversationState, HeldRecord } from "./conversation-state.js";
import type { HeldReading } from "./limit-booking.js";
import { BROADCAST, unchanged, withResume } from "./decision-parts.js";

// How a conversation's holds move by their own events. A held turn once it is held: a person's pick of an account
// re-points it, the resume pass reads where it can go, and a person picks how it continues. The hold on an idle
// conversation's prompt cache (cache-keepwarm.ts): armed, refreshed, ended.

// Only an unfired limit hold is re-pointed: every other wall is not about which account pays. A pick undoes a booked
// move, since the person has just said where it goes. The reading taken for the old route says nothing of the new one:
// the pick's own reading of the picked account goes on with it (switch-account.ts), else the next pass reads it.
// The refusal's own instant stays on the hold as evidence; where the turn now goes waits on the picked account's wall.
export const onHeldRepointed = (state: ConversationState, event: Extract<ConversationEvent, { kind: "held-repointed" }>): Decision<boolean> => {
    const { held } = state.resume;
    if (held === undefined || held.fired || held.reason !== "limit") {
        return unchanged(state, false);
    }
    const { reading: _old, ...rest } = held;
    const repointed: HeldRecord = {
        ...rest,
        ...opt("reading", event.reading),
        onto: { account: event.account, carry: event.carry },
        move: undefined,
    };
    return unchanged(withResume(state, { held: repointed }), true);
};

// What the resume pass read about where an unfired limit hold can go (held-verdict.ts), onto the very hold it read: one
// re-pointed, replaced or fired since is judged again by the next pass. Told to every window only when the reading
// moved, since the card's `next` and its reset are derived from it; an unchanged one leaves the record as it was, so the
// pass's reads come to rest instead of waking it again.
export const onHeldRead = (state: ConversationState, event: Extract<ConversationEvent, { kind: "held-read" }>): Decision<boolean> => {
    const { held } = state.resume;
    if (held === undefined || held !== event.judged || held.fired || held.reason !== "limit") {
        return unchanged(state, false);
    }
    if (sameReading(held.reading, event.reading)) {
        return unchanged(state, true);
    }
    return { state: withResume(state, { held: { ...held, reading: event.reading } }), effects: BROADCAST, reply: true };
};

const READING_KEYS = ["at", "reopensAt", "openSince", "moveTo"] as const satisfies readonly (keyof HeldReading)[];

const sameReading = (was: HeldReading | undefined, is: HeldReading): boolean =>
    was !== undefined && READING_KEYS.every((key) => was[key] === is[key]);

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
