import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { failureFingerprint, turnedAwayCode } from "@intentic/sandbox-contract/policy/failure-codes";
import { opt } from "../../opt.js";
import type { Ending, FailedEnding, PersistedAgent, PriorEnding } from "../registry/agents-store.js";
import type { ConversationEffect, ConversationEvent, Decision } from "./conversation-decide.js";
import { returned, waitingOf } from "./conversation-queue.js";
import type { ConversationState } from "./conversation-state.js";
import { BROADCAST, withQueue } from "./decision-parts.js";

// What a failed turn's ending records on its conversation, read off the turn's error frame (conversation-decide.ts).

// Long enough for a provider's own explanation; short enough that a stack trace or error page can't ride into the
// roster. One bounded line, no newlines; empty collapses to `undefined`.
const MAX_FAILURE_LENGTH = 400;
export const sanitizeFailure = (message: string): string | undefined => {
    const clean = message.replaceAll(/\s+/gu, " ").trim().slice(0, MAX_FAILURE_LENGTH);
    return clean === "" ? undefined : clean;
};

// The frame's own verdict decides, not the code, except a rate limit: its reopening can be hours away, so it is
// recorded as a failure rather than hidden as work in progress.
export const comingBackNow = (event: Extract<AgentEvent, { kind: "error" }>): boolean => event.autoResume === "scheduled" && event.code !== "rate_limit";

// A spent allowance is its own kind: the only failure with a reopening and a held turn to carry.
export const failureOf = (event: Extract<AgentEvent, { kind: "error" }>): FailedEnding => {
    const failure = sanitizeFailure(event.message);
    if (event.code !== "rate_limit") {
        return { kind: "failed", ...opt("failure", failure), ...opt("code", event.code), ...opt("own", event.own === true ? (true as const) : undefined) };
    }
    return {
        kind: "limited",
        ...opt("failure", failure),
        ...opt("resetsAt", event.resetsAt),
        // Whether it goes again by itself is never filed: the card derives it from the hold (conversation-next.ts).
        held: event.held !== undefined,
    };
};

// A failure the provider never answered, counted against the ending before it: the same failure again
// (failureFingerprint) adds one, anything else starts the count at one. A failure the provider answered counts nothing,
// since a retry may well get past it. The card reads the count (failureRepeats) to stop offering a press that would
// only fail the same way.
export const repeatedFailure = (
    before: Ending,
    failure: FailedEnding,
    turn: { readonly ranTurn: boolean; readonly answeredAt: number | undefined },
): FailedEnding => {
    if (failure.kind !== "failed" || !turn.ranTurn || turn.answeredAt !== undefined) {
        return failure;
    }
    const again =
        before.kind === "failed" && before.repeats !== undefined && failureFingerprint(before.code, before.failure) === failureFingerprint(failure.code, failure.failure);
    return { ...failure, repeats: again ? (before.repeats ?? 0) + 1 : 1 };
};

/* A TURN TURNED AWAY AT THE DOOR WITH A PERSON'S WORDS HANDED BACK RAN NOTHING: refused before the model saw a word, it
   stands for the words it holds and nothing else. It keeps the ending its `begin` replaced (agents-store.ts `over`), and
   the card goes back to that ending once none of its words wait. On 2026-11-24 a person took back the one message a
   memory refusal held (pollen-djsk), and the card sat in Attention as Held, holding nothing, its work long landed. */

/**
 * What a turn's `begin` sets aside, for a refusal at the door to go back to: the conversation's ending, or the one an
 * earlier refusal at the door set aside, so refusals in a row all go back to where the conversation stood before the
 * first. A conversation with no entry yet stood on nothing, which reads as idle.
 */
export const endingSetAside = (ending: Ending | undefined): PriorEnding => {
    if (ending === undefined) {
        return { kind: "idle" };
    }
    if (ending.kind !== "failed") {
        return ending;
    }
    const { over, ...failed } = ending;
    return over ?? failed;
};

/**
 * The entry once its settled turn proves to have been turned away at the door, its words handed back: the refusal keeps
 * `over`, and the turn is not counted, since none ran (a conversation whose only message was turned away and taken back
 * still reads as never opened, turn-admission.ts unopened). Only the refusal itself takes it, and only once: an entry
 * any other ending stands on is left as it is.
 */
export const turnedAwayEntry = (entry: PersistedAgent, over: PriorEnding): PersistedAgent => {
    const { ending } = entry;
    if (ending.kind !== "failed" || ending.over !== undefined || !turnedAwayCode(ending.code)) {
        return entry;
    }
    return { ...entry, ending: { ...ending, over }, totals: { ...entry.totals, turns: Math.max(0, entry.totals.turns - 1) } };
};

/**
 * The entry once none of the words a refusal at the door held wait any more: back on the ending the refusal set aside. A
 * spent allowance's no longer holds a turn, since the turn the refusal turned away superseded that hold. An entry no such
 * refusal stands on is left as it is.
 */
export const withdrawnEntry = (entry: PersistedAgent): PersistedAgent => {
    const { ending } = entry;
    if (ending.kind !== "failed" || ending.over === undefined) {
        return entry;
    }
    const { over } = ending;
    return { ...entry, ending: over.kind === "limited" ? { ...over, held: false } : over };
};

// How the conversation's events move such a refusal: the words coming back mark it (turn-admission.ts handBack), and a
// change that leaves none of them waiting withdraws it.

/**
 * Words a refusal at the door handed back, at the queue's head and held. Only a turn that ran nothing hands words back,
 * so the settled turn was no turn at all: its refusal keeps the ending its `begin` set aside, and it is not counted. Once
 * only, and never under a turn begun since, whose `begin` set aside its own.
 */
export const onReturned = (state: ConversationState, items: Extract<ConversationEvent, { kind: "queue-returned" }>["items"]): Decision<undefined> => {
    const back = withQueue(state, returned(state.queue, items), undefined);
    const over = state.turn.endingBefore;
    if (over === undefined || state.phase.kind !== "idle") {
        return back;
    }
    // The entry first, so the persist that writes the queue carries both.
    const effects = back.effects.length > 0 ? back.effects : [{ kind: "persist" } as const, ...BROADCAST];
    return {
        state: { ...back.state, turn: { ...back.state.turn, endingBefore: undefined } },
        effects: [{ kind: "entry-turned-away", over }, ...effects],
        reply: undefined,
    };
};

/**
 * Whatever the event, once it leaves none of the words a refusal at the door held waiting, with no turn running and no
 * held turn to speak for, the card goes back to the ending the refusal set aside: taken back, or booked for later, where
 * the booking speaks for itself. Read off the two states, as the kept hold is (conversation-decide.ts keepLimitHold), so
 * no way of emptying the queue can forget it.
 */
export const withdrawRefusal = <R>(before: ConversationState, decision: Decision<R>, entry: PersistedAgent | undefined): Decision<R> => {
    const { state, effects } = decision;
    if (
        entry?.ending.kind !== "failed" ||
        entry.ending.over === undefined ||
        state.phase.kind !== "idle" ||
        state.resume.held !== undefined ||
        waitingOf(before.queue).length === 0 ||
        waitingOf(state.queue).length > 0
    ) {
        return decision;
    }
    // Ahead of the event's own effects, so the persist and the broadcast it already makes carry the entry too.
    const owed = (kind: "persist" | "broadcast"): readonly ConversationEffect[] => (effects.some((effect) => effect.kind === kind) ? [] : [{ kind }]);
    return { ...decision, effects: [{ kind: "refusal-withdrawn" }, ...effects, ...owed("persist"), ...owed("broadcast")] };
};
