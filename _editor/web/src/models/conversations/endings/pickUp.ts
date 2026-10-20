import type { HandoffMode, HandoffOffer } from "@intentic/sandbox-contract/schemas/providers/handoff";
import type { HeldEnding, RetryLadder, TurnBreakPolicy } from "@intentic/sandbox-contract/schemas/turn-break";
import type { QueuedMessage } from "@intentic/sandbox-contract/schemas/agent";
import type { TurnEnding } from "@intentic/sandbox-contract/events/transcript";
import { formatClock, formatWeekdayTime } from "@intentic/ui/format";
import { t } from "@intentic/ui/i18n";
import { formatReset, formatWait } from "../../providers/usageStatus";
import { type AgentStanding, limited } from "../../agent-status/agentStatus-standing";

// One state for every turn ending that leaves finished work behind a live session. `reason` is the wall, `readyAt` a
// spent allowance's honest reopen time, `nextAt` the instant the daemon's own booking fires. Excludes endings that need
// a real fix (a dead credential, an unsupported model): those re-fail on press by construction, so no offer beats a bad
// one.
//
// What is deliberately NOT here: whether anything is armed. That is the conversation's answer to this ending's one
// question (turnBreak.ts), read the same way by every surface — which is what stops a frame saying "scheduled" while a
// switch elsewhere says off. `booked` is not that answer either: it is what the daemon made of it, read only for when.

export interface PickUp {
    /** Which wall left the work here; `flagged` is the one no standing answer covers, asked about each time. */
    readonly reason: HeldEnding;
    /** When the named allowance is due to reopen (ms); only a spent allowance has one. */
    readonly readyAt?: number;
    /** When the daemon's own booking fires (ms), as the frame, the record or the card stated it; absent means it fires on the next pass. */
    readonly nextAt?: number;
    /**
     * A spent allowance's held turn is on the daemon's books to go by itself (the frame's `autoResume`, the record's
     * `scheduled`, the card's `next`), so `nextAt` says when, and one past or never named goes on the next pass.
     */
    readonly booked?: true;
    /** How far a laddered wall's automatic re-runs have got (an outage's breaker, a stopped turn's rungs). */
    readonly retries?: RetryLadder;
    // The daemon is holding the turn itself, so the press re-runs it rather than sending a message. `ran` says whether
    // the held turn got anywhere before it was refused, since a blanket "work kept" was wrong for the common case of a
    // turn refused before its first request.
    readonly held?: HeldTurn;
    /**
     * Until when (ms, this browser's clock) the press stays shut after a spent allowance refused a turn before it ran:
     * pressing again at once is refused the same way, and seven presses in two minutes each came back "nothing ran".
     */
    readonly coolUntil?: number;
}

// The held turn as the daemon describes it, shared by the failure frame and the record's ending.
// `contextTokens`/`handoffTokens` are what each way back costs (re-read the session vs. pay only the hand-off);
// `moving` means the owner's policy is already relocating the turn. `handoff` is the choice of how a spent allowance's
// held turn continues once its cache is cold (carry the session, trim it, or summarise it), with the sandbox's suggestion
// and the person's pick; absent where there is only one way on.
export interface HeldTurn {
    readonly ran: boolean;
    readonly contextTokens?: number;
    readonly handoffTokens?: number;
    readonly moving?: string;
    readonly handoff?: HandoffOffer;
}

/** What a Continue press may say about how it goes on: keep the session across an account move, and which hand-off. */
export interface ContinueOptions {
    readonly carry?: boolean;
    readonly handoff?: HandoffMode;
}

/** The hand-off the next send of a held turn uses: the person's pick, else the sandbox's suggestion. */
export const handoffPicked = (held: HeldTurn | undefined): HandoffMode | undefined =>
    held?.handoff === undefined ? undefined : (held.handoff.chosen ?? held.handoff.suggested);

/** The pick-up once a person picked a hand-off on the card: every press, booked move and reset then uses it. */
export const withHandoffChosen = (pickUp: PickUp | undefined, chosen: HandoffMode | undefined): PickUp | undefined => {
    const handoff = pickUp?.held?.handoff;
    if (pickUp?.held === undefined || handoff === undefined) {
        return pickUp;
    }
    const { chosen: _was, ...offer } = handoff;
    return { ...pickUp, held: { ...pickUp.held, handoff: chosen === undefined ? offer : { ...offer, chosen } } };
};

// What the plain press pays, from the daemon's own numbers: a turn that ran resumes and re-reads its session, one
// refused at the door pays only the hand-off, and one with a choice of hand-offs pays what the picked one starts from.
// Undefined when the daemon measured none of it.
export type PressCost =
    | { readonly kind: `reread`; readonly tokens: number }
    | { readonly kind: `handoff`; readonly tokens: number }
    | { readonly kind: `trim`; readonly tokens: number }
    | { readonly kind: `summary`; readonly tokens: number };

export const pressCost = (held: HeldTurn | undefined): PressCost | undefined => {
    if (held === undefined) {
        return undefined;
    }
    const picked = handoffPicked(held);
    if (picked === `trim` && held.handoff?.trim !== undefined) {
        return { kind: `trim`, tokens: held.handoff.trim.tokens };
    }
    if (picked === `summary` && held.handoff?.summary !== undefined) {
        return { kind: `summary`, tokens: held.handoff.summary.tokens };
    }
    if (held.ran) {
        return held.contextTokens === undefined ? undefined : { kind: `reread`, tokens: held.contextTokens };
    }
    return held.handoffTokens === undefined ? undefined : { kind: `handoff`, tokens: held.handoffTokens };
};

// Same state as the daemon's own record (AgentTranscriptSchema.ending), for a window that didn't watch the turn die
// live. A projection, not a second reading: the stream and the record reach the identical value from either end,
// converting the wire's seconds to the client's milliseconds once, here. A spent allowance's `scheduled` rides along as
// `booked`, since the record names `nextAt` only while it is still ahead: without it, a booking already due would read
// as nothing booked.
export const pickUpOf = (ending: TurnEnding): PickUp => {
    const pickUp: PickUp = {
        reason: ending.reason,
        ...(ending.resetsAt === undefined ? {} : { readyAt: ending.resetsAt * 1_000 }),
        ...(ending.nextAt === undefined ? {} : { nextAt: ending.nextAt * 1_000 }),
        ...(ending.retries === undefined ? {} : { retries: ending.retries }),
        ...(ending.held === undefined ? {} : { held: ending.held }),
    };
    return ending.reason === `limit` && ending.scheduled === true ? { ...pickUp, booked: true } : pickUp;
};

/**
 * The pick-up as the board's card states the daemon's booking for it, once the card is about this ending (a spent
 * allowance, held as the pick-up is held): its reset, whether the held turn is booked and the instant it goes, and the
 * account a booked move takes it to all replace what the frame said, absent ones included. The sandbox re-times a hold
 * after the refusal (held-standing.ts) and re-points it when a person picks another account, in whichever window they
 * pick it (switch-account.ts), and only the card hears either. A card not about this ending yet (the turn still reads
 * running, another ending) leaves the frame's word until the roster catches up. Two conversations moved from one spent
 * Claude account to another were sent to be refused "now" while the composer counted down to the real reopen: the
 * chat's clock was inferred in three places, none of them the daemon's booking, and a pick made in another window never
 * reached it (2026-10-19).
 */
export const withCardBooking = (pickUp: PickUp | undefined, card: AgentStanding | undefined): PickUp | undefined => {
    if (pickUp?.reason !== `limit` || card === undefined || !limited(card) || (card.limitHeld === true) !== (pickUp.held !== undefined)) {
        return pickUp;
    }
    const { readyAt: _ready, nextAt: _next, booked: _booked, held, ...rest } = pickUp;
    const timed: PickUp = card.limitResetsAt === undefined ? rest : { ...rest, readyAt: card.limitResetsAt * 1_000 };
    const rerun = card.next?.kind === `rerun` ? card.next : undefined;
    const when: PickUp = rerun === undefined ? timed : { ...timed, booked: true, nextAt: rerun.at };
    return held === undefined ? when : { ...when, held: movingTo(held, rerun?.onto) };
};

// The held turn with the move the card says is booked for it, or none.
const movingTo = ({ moving: _was, ...held }: HeldTurn, moving: string | undefined): HeldTurn => (moving === undefined ? held : { ...held, moving });

// How long Continue rests after a spent allowance refused a turn at the door (see PickUp.coolUntil). Short, since the
// provider's reset guess is routinely early and the press is the way to find out; long enough that a second press is a
// decision rather than a reflex.
export const LIMIT_COOLDOWN_MS = 60_000;

// The pick-up a limit refusal leaves, resting when nothing ran: the one refusal a press repeats exactly.
export const cooledPickUp = (pickUp: PickUp, now: number = Date.now()): PickUp =>
    pickUp.reason === `limit` && pickUp.held?.ran === false ? { ...pickUp, coolUntil: now + LIMIT_COOLDOWN_MS } : pickUp;

// The same pick-up once its rest is over, so a view whose clock is not ticking reads it as pressable again.
export const warmedPickUp = ({ coolUntil: _rest, ...pickUp }: PickUp): PickUp => pickUp;

// Whether the press is resting after a refusal (cooledPickUp).
export const pickUpCooling = (pickUp: PickUp, now: number = Date.now()): boolean => pickUp.coolUntil !== undefined && now < pickUp.coolUntil;

/**
 * When the sandbox's own words waiting here can go (ms): the instant a spent allowance reopens, while the daemon holds the
 * turn behind it and nobody typed anything that waits. The client's reading of the daemon's rule (turn-admission.ts,
 * heldBehindLimit): a turn opened before then is refused at the door and would take the held work's place, so a watch's
 * report or an agent's word waits for the window and goes with the held turn. Until then nothing lets them go early, so
 * no press may offer that. Undefined when what waits goes the ordinary way.
 */
export const wakesHeldUntil = (pickUp: PickUp | undefined, waiting: readonly QueuedMessage[], now: number = Date.now()): number | undefined => {
    if (pickUp?.reason !== `limit` || pickUp.held === undefined || pickUp.readyAt === undefined || pickUp.readyAt <= now) {
        return undefined;
    }
    return waiting.length > 0 && waiting.every((message) => message.voice !== `person`) ? pickUp.readyAt : undefined;
};

// Past this, a wall-clock time reads better than a countdown nobody can act on; under it, the relative wait wins.
const CLOCK_FROM_MS = 90 * 60 * 1_000;

// A held turn is always pressable, whatever the reset says: disabling it protected against a re-fail that costs nothing
// (the daemon's own fire is idempotent), while a dead button next to a countdown just pushed the user to type the word
// by hand instead. Only endings with nothing held still gate on the reset, where a press really would append a message.
// The one exception is the short rest after a refusal where nothing ran (cooledPickUp), which the status line explains.
export const pickUpReady = (pickUp: PickUp, now: number = Date.now()): boolean =>
    !pickUpCooling(pickUp, now) && (pickUp.held !== undefined || pickUp.readyAt === undefined || pickUp.readyAt <= now);

/**
 * An instant as every surface says it: a countdown while close, the weekday and time plus the wait once far off. One
 * helper, because the same reset rendered two ways in two rows of the same card ("back at Sun 08:20" over "in about 244
 * min") is how a reader concludes there are two different waits.
 */
export const pickUpWhen = (at: number, now: number = Date.now()): string =>
    at - now >= CLOCK_FROM_MS
        ? t(`chat.turnBreak.whenFar`, { clock: formatReset(Math.round(at / 1_000), now), wait: formatWait(Math.round(at / 1_000), now) })
        : t(`chat.turnBreak.whenNear`, { wait: formatWait(Math.round(at / 1_000), now) });

// Whether pickUpShort says an instant as a wait ("40m") rather than a clock: what picks "in" over "at" around it.
const shortIsWait = (at: number, now: number): boolean => Math.ceil((at - now) / 60_000) < 90;

// The narrowest honest label for an instant, for a button with room for a few characters: minutes while close, the
// clock later today, the weekday past that. The longer sentence (pickUpWhen) belongs in the tooltip beside it.
export const pickUpShort = (at: number, now: number = Date.now()): string => {
    const minutes = Math.ceil((at - now) / 60_000);
    if (shortIsWait(at, now)) {
        return t(`chat.composerIntent.inMinutes`, { minutes: Math.max(1, minutes) });
    }
    return new Date(at).toDateString() === new Date(now).toDateString() ? formatClock(at) : formatWeekdayTime(at);
};

/** The "at" and the "in" form of one sentence about a reopen, each given the instant as pickUpShort words it. */
export interface ReopenPhrases {
    readonly at: (when: string) => string;
    readonly in: (when: string) => string;
}

/**
 * A press that goes at an instant, worded around pickUpShort: "Continue at 02:00", "Continue in 40m". Each caller words
 * the two forms with its own `t()` calls, so every press that waits for a reopen reads the same way and each message is
 * asked for where the i18n check can see it.
 */
export const atReopenPhrase = (phrases: ReopenPhrases, at: number, now: number = Date.now()): string =>
    (shortIsWait(at, now) ? phrases.in : phrases.at)(pickUpShort(at, now));

// The strip's one status line: what happened, and what survived. Built here rather than in the template so the wording
// is tested directly and the several endings can't drift apart. What happens NEXT is deliberately not in it — that is
// the control's own business, one line below, and saying it twice is what put two clocks on one card.

// The one thing a reader can't check themselves: whether the held turn got anywhere before the wall.
const survived = (pickUp: PickUp): boolean => pickUp.held?.ran !== false;

// Said out loud since a ladder spending the user's allowance unwatched owes an account of itself; nothing before its
// first re-run.
const retriedSoFar = (pickUp: PickUp): string =>
    pickUp.retries === undefined || pickUp.retries.made === 0 ? `` : ` · ${t(`chat.turnBreak.retriedOf`, { ...pickUp.retries })}`;

/**
 * `spentUntil` is when the account the press would run on reopens (ms), while it reads spent with that still ahead: the
 * wall actually in the way now, whatever stopped the turn. A limit ending already says its own reopen; any other ending
 * says this one beside what happened, since a turn that stopped short on a spent account cannot go on before it either.
 */
export const pickUpStatus = (pickUp: PickUp, now: number = Date.now(), spentUntil?: number): string => {
    if (pickUp.reason === `limit`) {
        return limitStatus(pickUp, now);
    }
    const spent =
        spentUntil === undefined || spentUntil <= now ? `` : ` · ${t(`chat.turnBreak.allowanceBack`, { when: pickUpWhen(spentUntil, now) })}`;
    return `${originStatus(pickUp)}${spent}`;
};

// What happened, for every ending but a spent allowance.
const originStatus = (pickUp: PickUp): string => {
    if (pickUp.reason === `flagged`) {
        return survived(pickUp) ? t(`chat.turnBreak.flaggedStatusKept`) : t(`chat.turnBreak.flaggedStatus`);
    }
    if (pickUp.reason === `outage`) {
        return `${t(`chat.turnBreak.outageStatus`)}${retriedSoFar(pickUp)}`;
    }
    return `${t(`chat.turnBreak.stoppedStatus`)}${retriedSoFar(pickUp)}`;
};

// Limit reached comes in two shapes: work kept (hit mid-flight) or nothing ran (spent before the first request);
// claiming survival for both undermines trust in this line. The reset instant is stated, not promised ("back", not "not
// before"): it's the provider's own guess and is routinely wrong in the useful direction, which is why a press stays
// live ahead of it.
const limitStatus = (pickUp: PickUp, now: number): string => {
    const head = survived(pickUp) ? t(`chat.turnBreak.limitStatusKept`) : t(`chat.turnBreak.limitStatusRefused`);
    // No instant published (Z.ai, Grok, Cursor) is said as such, rather than left for "shortly" to imply one.
    const due =
        pickUp.readyAt === undefined
            ? ` · ${t(`chat.turnBreak.resetUnknown`)}`
            : pickUp.readyAt <= now
              ? ``
              : ` · ${t(`chat.turnBreak.backWhen`, { when: pickUpWhen(pickUp.readyAt, now) })}`;
    const resting = pickUpCooling(pickUp, now) ? ` · ${t(`chat.turnBreak.coolingDown`)}` : ``;
    return `${head}${due}${resting}`;
};

/**
 * What the chosen answer will actually do, in one line under the control, or nothing while the answer is `wait` — the
 * selected chip already says that, and a line repeating it is the second strip all over again. Reads the answer rather
 * than the frame, so it changes the instant the reader changes their mind.
 */
export const pickUpNext = (pickUp: PickUp, policy: TurnBreakPolicy, now: number = Date.now()): string | undefined => {
    // A booked move fires on the next pass and names its destination instead of an hour.
    if (pickUp.held?.moving !== undefined) {
        return t(`chat.turnBreak.movingNow`, { account: pickUp.held.moving });
    }
    if (policy === `wait`) {
        return undefined;
    }
    const at = pickUp.nextAt ?? pickUp.readyAt;
    // A laddered retry counts its tries; an allowance reopening is a one-shot appointment, with nothing to count.
    if (pickUp.retries !== undefined) {
        return ladderNext(pickUp.retries, at, now);
    }
    if (pickUp.reason === `limit`) {
        return limitNext(pickUp, now);
    }
    return goesWhen(at, now);
};

// Goes by itself at `at`, or shortly once that is past or was never named.
const goesWhen = (at: number | undefined, now: number): string =>
    at === undefined || at <= now ? t(`chat.turnBreak.goesSoon`) : t(`chat.turnBreak.goesAt`, { when: pickUpWhen(at, now) });

// A booked spent allowance goes when the daemon's pass says (`nextAt`), which is later than the reset where the account
// it goes on is still spent then, and one already due goes on the next pass: booked is never "never". A sandbox older
// than that instant states the booking alone, which it fires at the reset. An answer not booked yet (just chosen, the
// roster not caught up) says what it would do: go at the reset. One with no published reset has nothing to book against
// (classify-failure.ts arms only a known instant), so nothing goes by itself: "shortly" there was a promise no clock kept.
const limitNext = (pickUp: PickUp, now: number): string => {
    if (pickUp.booked === true) {
        return goesWhen(pickUp.nextAt ?? pickUp.readyAt, now);
    }
    return pickUp.readyAt === undefined ? t(`chat.turnBreak.goesNever`) : goesWhen(pickUp.readyAt, now);
};

// A spent ladder books nothing, whatever the answer says: the press is the only way on, and the line says so.
const ladderNext = (retries: RetryLadder, at: number | undefined, now: number): string => {
    if (retries.made >= retries.max) {
        return t(`chat.turnBreak.ladderSpent`, { max: retries.max });
    }
    const attempt = { attempt: retries.made + 1, max: retries.max };
    return at === undefined || at <= now
        ? t(`chat.turnBreak.nextTrySoon`, attempt)
        : t(`chat.turnBreak.nextTry`, { ...attempt, when: pickUpWhen(at, now) });
};
