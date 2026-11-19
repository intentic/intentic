import { breakArmed, type TurnBreakPolicy } from "@intentic/sandbox-contract/schemas/turn-break";
import { opt } from "../../opt.js";
import type { HeldRecord } from "./conversation-state.js";

/* WHETHER A SPENT ALLOWANCE'S HELD TURN GOES AGAIN BY ITSELF, WHEN, AND WHERE: ONE RULE FOR EVERYTHING THAT SAYS SO. The
   resume pass fires by it (agent/run/turn/holds/held-verdict.ts, through turn-resume.ts runLimitHold), the card's `next`
   is derived from it every time the card is read (conversation-next.ts), and the sleep wake reads it (booked-release.ts
   nextBookedSendAt), so a card is in Active exactly when this rule says something will send it. Its inputs are the
   hold's own intent (where it was refused, a booked move, a person's pick, the refusal's own instant as evidence), the
   conversation's answer to the limit, and the records' live word on where it could go (HeldReading, read by the resume
   pass at every pass and kept on the hold for the readers that cannot wait for one).

   2026-11-19: the hold used to carry copies of these decisions and reconcile them after the fact: the reopen re-timed in
   place by two paced passes (an untimed hold learning its pool's reopen, a timed one brought forward once its model
   could be served), the wall in front of where it went written onto it every beat (`walledUntil`), a pick's reopen
   judged once at the pick, and a booked move's destination judged once at the failure and then waited behind once it
   was spent. Each path that changed the records between those writes left the hold, and the card, on an instant the
   pass would no longer keep. Keeping those copies and adding the next reconciliation was rejected: the instant and the
   destination are now read, never kept, and the reading is written by the pass alone. */

/**
 * How long after an allowance's reset the sandbox waits before sending into it by itself. A reset is the provider's own
 * clock, and a request sent the instant it names can land before the provider has turned the window over: at
 * 2026-10-26 00:00:00 two Codex turns booked for that reset were refused within three seconds ("try again at 11:59 PM"),
 * and one lost its summary hand-off on that refusal; the same allowance served both a minute or two later. A person's
 * own press still goes the moment they press it.
 */
export const RESET_GRACE_MS = 60_000;

/** The instant (ms) the sandbox's own sends may go into an allowance that reopens at `reopensAt` (epoch seconds). */
export const sendableAt = (reopensAt: number): number => reopensAt * 1000 + RESET_GRACE_MS;

/**
 * The reopen (epoch seconds) of a hold due at `now` (ms) rather than at any provider's reset: one whose grace runs out
 * within the second, so sendableAt reads it as now. What a card states for a route found open: no clock left to show.
 */
export const reopenedBy = (now: number): number => Math.ceil((now - RESET_GRACE_MS) / 1000);

/**
 * The instant (ms) a limit hold goes at its reset, the grace after it, or undefined: none named, or one already past
 * when it was refused, which would only loop. A refusal inside the grace is the provider's clock not yet turned over,
 * and goes once more when the grace is out.
 */
export const heldReopensAt = (held: { readonly reopensAt?: number | undefined; readonly recordedAt: number }): number | undefined => {
    const at = held.reopensAt === undefined ? undefined : sendableAt(held.reopensAt);
    return at === undefined || at <= held.recordedAt ? undefined : at;
};

/**
 * What the records said about where an unfired limit hold can go, the last time the resume pass read them
 * (held-verdict.ts readHeld, through the `held-read` event, its only writer; a pick reads one through the same module
 * as it re-points the hold). Memory only: never stored, read again by every pass and after a restart.
 */
export interface HeldReading {
    // When the route it takes without a move (a person's pick, else the account it was refused on) lets it through by
    // itself (ms, the grace after a reopen included). Absent: nothing names one, so only a press sends it.
    readonly at?: number;
    // The reopen (epoch s) the card states for that route (`limitResetsAt`) and the window the sandbox's own words wait
    // behind (conversation-state.ts windowShut): the wall in front of it, else the refusal's own instant, else the instant
    // it was found open. Absent where none is known.
    readonly reopensAt?: number;
    // When a pass first found the route open before the instant it was refused with (ms). Each reading keeps it while
    // the route stays open, so the instant a child goes (spread past it) holds still between passes rather than sliding
    // with the clock; a reading that finds it walled again drops it.
    readonly openSince?: number;
    // Where a booked move goes now: the account it was booked onto while that can serve, else another with room
    // (placement.ts moveDestinationFor). Absent where no account has room: the hold then waits on its own route.
    readonly moveTo?: string;
}

// The reading of a hold no pass has read yet (just held, re-pointed without one, or put back by a restart): the
// refusal's own word, which is what its failure frame stated (classify-failure.ts limitFrame). The next pass, nudged by
// the hold being recorded, replaces it.
const unread = (held: HeldRecord): HeldReading => ({
    ...opt("at", heldReopensAt(held)),
    ...opt("reopensAt", held.reopensAt),
    ...opt("moveTo", held.move?.account),
});

/** The reading a limit hold is judged by: the pass's last, else the refusal's own word. */
const readingOf = (held: HeldRecord): HeldReading => held.reading ?? unread(held);

/** What a held turn does by itself: goes at `at` (ms, possibly past: the next pass), and to `moving` where it moves. */
export interface LimitBooking {
    readonly at: number;
    readonly moving?: string;
}

/**
 * What an unfired spent-allowance hold does by itself under `policy`, the conversation's answer to the limit: a booked
 * move at once while that answer is still to move and an account has room for it, else the instant its route lets it
 * through under any answer that sends. Undefined when only a press sends it: no hold, a fired one, another kind of hold,
 * an answer to wait, or no instant to go at. A hold left untimed on purpose (a child's reset past its horizon) has none.
 */
export const limitBooking = (held: HeldRecord | undefined, policy: TurnBreakPolicy): LimitBooking | undefined => {
    if (held?.reason !== "limit" || held.fired || !breakArmed(policy)) {
        return undefined;
    }
    const reading = readingOf(held);
    if (held.move !== undefined && policy === "move" && reading.moveTo !== undefined) {
        return { at: held.recordedAt, moving: reading.moveTo };
    }
    return reading.at === undefined ? undefined : { at: reading.at };
};

/** The reopen (epoch s) the card states for a limit hold's route, by its reading; undefined for any other hold. */
export const heldReopen = (held: HeldRecord | undefined): number | undefined => (held?.reason === "limit" ? readingOf(held).reopensAt : undefined);

/** Where a limit hold's booked move goes as the records read now, whatever the answer; undefined with no move or no room. */
export const heldMoving = (held: HeldRecord): string | undefined => (held.move === undefined ? undefined : readingOf(held).moveTo);
