import type { TurnEnding } from "@intentic/sandbox-contract";
import { formatReset, formatWait } from "../session/usageStatus";

// One state for every turn ending that leaves finished work behind a live session. `reason` is the sentence, `readyAt`
// a spent allowance's honest reopen time, `automatic` flags something else already bringing the turn back. Excludes
// endings that need a real fix (a dead credential, an unsupported model): those re-fail on press by construction, so no
// offer beats a bad one.

export type PickUpReason = `stopped` | `limit` | `outage`;

export interface PickUp {
    /** Which ending left the work here; read only for its sentence. */
    readonly reason: PickUpReason;
    /** When the named allowance is due to reopen (ms); only a spent allowance has one. */
    readonly readyAt?: number;
    /** Something other than this window is already bringing the turn back, and when (ms). */
    readonly automatic?: { readonly at: number };
    // The daemon is holding the turn itself, so the press re-runs it rather than sending a message. `ran` says whether
    // the held turn got anywhere before it was refused, since a blanket "work kept" was wrong for the common case of a
    // turn refused before its first request.
    readonly held?: HeldTurn;
}

// The held turn as the daemon describes it, shared by the failure frame and the record's ending.
// `contextTokens`/`handoffTokens` are what each way back costs (re-read the session vs. pay only the hand-off);
// `moving` means the owner's policy is already relocating the turn.
export interface HeldTurn {
    readonly ran: boolean;
    readonly contextTokens?: number;
    readonly handoffTokens?: number;
    readonly moving?: string;
}

// What the plain press pays, from the daemon's own numbers: a turn that ran resumes and re-reads its session, one
// refused at the door pays only the hand-off. Undefined when the daemon measured neither.
export type PressCost = { readonly kind: `reread`; readonly tokens: number } | { readonly kind: `handoff`; readonly tokens: number };

export const pressCost = (held: HeldTurn | undefined): PressCost | undefined => {
    if (held === undefined) {
        return undefined;
    }
    if (held.ran) {
        return held.contextTokens === undefined ? undefined : { kind: `reread`, tokens: held.contextTokens };
    }
    return held.handoffTokens === undefined ? undefined : { kind: `handoff`, tokens: held.handoffTokens };
};

// Same state as the daemon's own record (AgentTranscriptSchema.ending), for a window that didn't watch the turn die
// live. A projection, not a second reading: the stream and the record reach the identical value from either end,
// converting the wire's seconds to the client's milliseconds once, here. `automatic` only appears with an instant to
// aim at; a booking with no hour isn't an appointment.
export const pickUpOf = (ending: TurnEnding, now: number = Date.now()): PickUp => {
    const readyAt = ending.resetsAt === undefined ? undefined : ending.resetsAt * 1_000;
    // A booked move has no hour to aim at: it goes on the next pass, "now" to a reader.
    const moving = ending.held?.moving !== undefined;
    const at = moving ? now : readyAt;
    return {
        reason: ending.reason,
        ...(readyAt === undefined ? {} : { readyAt }),
        ...(ending.held === undefined ? {} : { held: ending.held }),
        ...(ending.scheduled === true && at !== undefined ? { automatic: { at } } : {}),
    };
};

// Past this, a wall-clock time reads better than a countdown nobody can act on; under it, the relative wait wins.
const CLOCK_FROM_MS = 90 * 60 * 1_000;

// A held turn is always pressable, whatever the reset says: disabling it protected against a re-fail that costs nothing
// (fireLimitResume is idempotent), while a dead button next to a countdown just pushed the user to type the word by
// hand instead. Only endings with nothing held still gate on the reset, where a press really would append a message.
export const pickUpReady = (pickUp: PickUp, now: number = Date.now()): boolean =>
    pickUp.held !== undefined || pickUp.readyAt === undefined || pickUp.readyAt <= now;

/** An instant as the strip says it: a countdown while close, a weekday and time once far off. */
const pickUpWhen = (at: number, now: number = Date.now()): string =>
    at - now >= CLOCK_FROM_MS ? `at ${formatReset(Math.round(at / 1_000))}` : `in ${formatWait(Math.round(at / 1_000), now)}`;

/** How many tries the daemon's outage breaker has left. */
export interface PickUpAttempts {
    readonly attempt: number;
    readonly maxAttempts: number;
}

// Builds the strip's one status line here rather than in the template, so wording is tested directly and the several
// endings can't drift apart. Always three facts in order: what happened, what survived (work kept vs. nothing ran), and
// when — everything else moved onto the control it's about (e.g. the press's own tooltip).

// Said out loud since an automation spending the user's allowance unwatched owes an account of itself.
const attemptsSaid = (attempts: PickUpAttempts | undefined): string =>
    attempts === undefined ? `` : ` · try ${attempts.attempt} of ${attempts.maxAttempts}`;

// Two waits that look alike but aren't: an outage retry is a guess (hence the attempt count), a limit's reopening is a
// one-shot appointment from the provider with nothing to retry and nothing to count.
const automaticStatus = (pickUp: PickUp, at: number, attempts: PickUpAttempts | undefined, now: number): string => {
    if (pickUp.reason !== `limit`) {
        return `Provider failed · retrying ${pickUpWhen(at, now)}${attemptsSaid(attempts)}`;
    }
    // A move names where the turn is going; it fires at once, so there's no hour to state.
    return pickUp.held?.moving === undefined
        ? `Limit reached · sending again ${pickUpWhen(at, now)}`
        : `Limit reached · ${survivedOf(pickUp)} · moving to ${pickUp.held.moving} now`;
};

// The one thing a reader can't check themselves: whether the held turn got anywhere before the wall.
const survivedOf = (pickUp: PickUp): string => (pickUp.held?.ran === false ? `nothing ran` : `work kept`);

export const pickUpStatus = (pickUp: PickUp, attempts: PickUpAttempts | undefined, now: number = Date.now()): string => {
    if (pickUp.automatic !== undefined) {
        return automaticStatus(pickUp, pickUp.automatic.at, attempts, now);
    }
    if (pickUp.reason === `outage`) {
        return `Provider failed · work kept`;
    }
    if (pickUp.reason === `limit`) {
        // Limit reached comes in two shapes: work kept (hit mid-flight) or nothing ran (spent before the first
        // request); claiming survival for both undermines trust in this line. The reset instant is stated, not promised
        // ("back at", not "not before"): it's the provider's own guess and is routinely wrong in the useful direction,
        // which is why the press stays live ahead of it.
        const due = pickUp.readyAt === undefined || pickUp.readyAt <= now ? `` : ` · back ${pickUpWhen(pickUp.readyAt, now)}`;
        return `Limit reached · ${survivedOf(pickUp)}${due}`;
    }
    return `Turn stopped short · work kept`;
};
