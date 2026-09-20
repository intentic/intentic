import type { TurnBreak, TurnBreakPolicy, TurnEnding } from "@intentic/sandbox-contract";
import { t } from "@intentic/ui/i18n";
import { formatReset, formatWait } from "../session/usageStatus";

// One state for every turn ending that leaves finished work behind a live session. `reason` is the wall, `readyAt` a
// spent allowance's honest reopen time, `nextAt` the instant the daemon's own booking fires. Excludes endings that need
// a real fix (a dead credential, an unsupported model): those re-fail on press by construction, so no offer beats a bad
// one.
//
// What is deliberately NOT here: whether anything is armed. That is the conversation's answer to this ending's one
// question (turnBreak.ts), read the same way by every surface — which is what stops a frame saying "scheduled" while a
// switch elsewhere says off.

export interface PickUp {
    /** Which wall left the work here. */
    readonly reason: TurnBreak;
    /** When the named allowance is due to reopen (ms); only a spent allowance has one. */
    readonly readyAt?: number;
    /** When the daemon's own booking fires (ms), as the failure frame stated it; absent means it fires on the next pass. */
    readonly nextAt?: number;
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
// converting the wire's seconds to the client's milliseconds once, here.
export const pickUpOf = (ending: TurnEnding): PickUp => ({
    reason: ending.reason,
    ...(ending.resetsAt === undefined ? {} : { readyAt: ending.resetsAt * 1_000 }),
    ...(ending.nextAt === undefined ? {} : { nextAt: ending.nextAt * 1_000 }),
    ...(ending.held === undefined ? {} : { held: ending.held }),
});

// Past this, a wall-clock time reads better than a countdown nobody can act on; under it, the relative wait wins.
const CLOCK_FROM_MS = 90 * 60 * 1_000;

// A held turn is always pressable, whatever the reset says: disabling it protected against a re-fail that costs nothing
// (the daemon's own fire is idempotent), while a dead button next to a countdown just pushed the user to type the word
// by hand instead. Only endings with nothing held still gate on the reset, where a press really would append a message.
export const pickUpReady = (pickUp: PickUp, now: number = Date.now()): boolean =>
    pickUp.held !== undefined || pickUp.readyAt === undefined || pickUp.readyAt <= now;

/**
 * An instant as every surface says it: a countdown while close, the weekday and time plus the wait once far off. One
 * helper, because the same reset rendered two ways in two rows of the same card ("back at Sun 08:20" over "in about 244
 * min") is how a reader concludes there are two different waits.
 */
export const pickUpWhen = (at: number, now: number = Date.now()): string =>
    at - now >= CLOCK_FROM_MS
        ? t(`chat.turnBreak.whenFar`, { clock: formatReset(Math.round(at / 1_000), now), wait: formatWait(Math.round(at / 1_000), now) })
        : t(`chat.turnBreak.whenNear`, { wait: formatWait(Math.round(at / 1_000), now) });

/** How many tries the daemon's outage breaker has left. */
export interface PickUpAttempts {
    readonly attempt: number;
    readonly maxAttempts: number;
}

// The strip's one status line: what happened, and what survived. Built here rather than in the template so the wording
// is tested directly and the several endings can't drift apart. What happens NEXT is deliberately not in it — that is
// the control's own business, one line below, and saying it twice is what put two clocks on one card.

// The one thing a reader can't check themselves: whether the held turn got anywhere before the wall.
const survived = (pickUp: PickUp): boolean => pickUp.held?.ran !== false;

export const pickUpStatus = (pickUp: PickUp, attempts: PickUpAttempts | undefined, now: number = Date.now()): string => {
    if (pickUp.reason === `outage`) {
        // Said out loud since a breaker spending the user's allowance unwatched owes an account of itself.
        const tries = attempts === undefined ? `` : ` · ${t(`chat.turnBreak.tryOf`, { ...attempts })}`;
        return `${t(`chat.turnBreak.outageStatus`)}${tries}`;
    }
    if (pickUp.reason === `limit`) {
        // Limit reached comes in two shapes: work kept (hit mid-flight) or nothing ran (spent before the first
        // request); claiming survival for both undermines trust in this line. The reset instant is stated, not promised
        // ("back", not "not before"): it's the provider's own guess and is routinely wrong in the useful direction,
        // which is why the press stays live ahead of it.
        const head = survived(pickUp) ? t(`chat.turnBreak.limitStatusKept`) : t(`chat.turnBreak.limitStatusRefused`);
        const due = pickUp.readyAt === undefined || pickUp.readyAt <= now ? `` : ` · ${t(`chat.turnBreak.backWhen`, { when: pickUpWhen(pickUp.readyAt, now) })}`;
        return `${head}${due}`;
    }
    return t(`chat.turnBreak.stoppedStatus`);
};

/**
 * What the chosen answer will actually do, in one line under the control, or nothing while the answer is `wait` — the
 * selected chip already says that, and a line repeating it is the second strip all over again. Reads the answer rather
 * than the frame, so it changes the instant the reader changes their mind.
 */
export const pickUpNext = (
    pickUp: PickUp,
    policy: TurnBreakPolicy,
    attempts: PickUpAttempts | undefined,
    now: number = Date.now(),
): string | undefined => {
    // A booked move fires on the next pass and names its destination instead of an hour.
    if (pickUp.held?.moving !== undefined) {
        return t(`chat.turnBreak.movingNow`, { account: pickUp.held.moving });
    }
    if (policy === `wait`) {
        return undefined;
    }
    const at = pickUp.nextAt ?? pickUp.readyAt;
    if (at === undefined || at <= now) {
        return t(`chat.turnBreak.goesSoon`);
    }
    // An outage retry is a guess and says how many it has left; an allowance reopening is a one-shot appointment from
    // the provider, with nothing to count.
    if (pickUp.reason === `outage` && attempts !== undefined) {
        return t(`chat.turnBreak.nextTry`, { when: pickUpWhen(at, now), ...attempts });
    }
    return t(`chat.turnBreak.goesAt`, { when: pickUpWhen(at, now) });
};
