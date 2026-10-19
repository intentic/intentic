import type { TodoItem } from "@intentic/sandbox-contract/events/requests";
import type { HandoffOffer } from "@intentic/sandbox-contract/schemas/providers/handoff";
import type { TurnInput } from "../../../../seams/turn-starter.js";
import type { VerificationStanding } from "../../../verification/agent-verification.js";

// What a held turn is, per wall: the record every wall's hold shares, and what only one wall's carries. The resume pass
// that fires them is turn-resume.ts; the stored copy that survives a restart is limit-hold.ts.

// The wall a held turn stopped at; `stopped` is a death with nothing to repair, `door` a refusal before the model saw it,
// `flagged` the provider's safety classifier stopping it partway.
export type HeldReason = "limit" | "stopped" | "overflow" | "door" | "outage" | "auth" | "flagged";

// A turn a wall stranded, held for a press (however long it takes) or the resume pass (RUNGS). One shape per wall: what
// only a spent allowance's hold carries (where it goes next, its reopen, its ways on) cannot be written onto a stopped
// turn's, and a booked move and a person's pick cannot both be where it goes. Each key another wall owns reads
// `undefined` here, which is what it always was at run time, so a read needs no narrowing and a write that would make a
// hold no wall makes does not compile. The stored copy stays one flat record (limit-hold.ts), rebuilt into this on boot.
export type HeldTurn = LimitHeld | AuthHeld | FlaggedHeld | PlainHeld;

// What every held turn carries, whatever wall it stopped at.
interface HeldBase {
    readonly input: TurnInput & { conversationId: string };
    // The run a door refusal ended, whose recorded rows are no history: the model never saw them.
    readonly run?: string;
    // The session the failed turn last reported; kept even when unused, so the fire can decide via `ran`.
    readonly sessionId?: string;
    // Whether the provider answered before the wall; false makes its session unsafe to reuse.
    readonly ran: boolean;
    // What the turn left behind at death (paths edited, verification, checklist); absent when refused at the door.
    readonly standing?: VerificationStanding | undefined;
    readonly checklist?: readonly TodoItem[] | undefined;
    // Token costs from the failure frame, kept so a reopened tab's record matches the numbers the live frame showed.
    readonly contextTokens?: number | undefined;
    readonly handoffTokens?: number | undefined;
}

// An account a spent allowance's held turn goes on instead of the one that refused it, and whether its session goes too.
export interface AccountPick {
    readonly account: string;
    readonly carry: boolean;
}

// Where a spent allowance's held turn goes next, if not back to the account that refused it: never both at once.
type LimitNext =
    // Where the owner's policy decided to move this turn, decided once at the failure; the pass only performs it.
    | { readonly move?: AccountPick | undefined; readonly onto?: undefined }
    // Where a person's pick in the picker re-pointed it (switchAccount without `run`): not a move, since a pick is never
    // a press, but the account the booked re-run goes on when it fires, at that account's reopen instead. Undoes a move.
    | { readonly onto: AccountPick; readonly move?: undefined };

interface LimitOwn {
    // Epoch seconds the allowance reopens. Absent (Grok, Cursor publish none) means press-only, never guessed.
    readonly reopensAt?: number;
    // Set when the other account refuses the carried session, so the retry opens fresh instead of replaying it.
    readonly carryRefused?: boolean | undefined;
    // The ways a spent allowance's held turn can continue once its cache is cold, measured at the failure, with the one
    // the sandbox suggests and the one a person picked (agent/providers/limit-handoff.ts). Absent: one way on, as before.
    readonly handoff?: HandoffOffer | undefined;
    // A spent allowance's hold taken at the door (spent-door.ts): nothing was sent, so the re-run goes as a door's does,
    // on the session as the last turn left it, rather than as a refused turn's, which opens fresh.
    readonly turnedAway?: boolean | undefined;
}

interface AuthOwn {
    // An auth hold's credential: the account to re-mint, and the refused token the rotation must supersede, not replay.
    readonly remint?: { readonly account: string; readonly refusedToken: string } | undefined;
}

interface FlaggedOwn {
    // A flagged hold's session entry before the stopped response (refusal-fork.ts): the re-run resumes there, so the
    // model never reads what the classifier stopped. Absent when the CLI named no such point: a plain resume then.
    readonly resumeAt?: string | undefined;
}

/** The hold one wall makes, as a fixture or a reader narrowed to it builds one. */
export type HeldOf<R extends HeldReason> = Extract<HeldTurn, { readonly reason: R }>;

// The keys another wall owns, read as absent.
type None<T> = { readonly [K in keyof T]?: undefined };

export type LimitHeld = HeldBase & LimitOwn & LimitNext & None<AuthOwn> & None<FlaggedOwn> & { readonly reason: "limit" };
type AuthHeld = HeldBase & AuthOwn & None<LimitOwn & { move: unknown; onto: unknown }> & None<FlaggedOwn> & { readonly reason: "auth" };
type FlaggedHeld = HeldBase & FlaggedOwn & None<LimitOwn & { move: unknown; onto: unknown }> & None<AuthOwn> & { readonly reason: "flagged" };
// One shape per plain wall, so each reason is a single discriminant a check narrows to.
type PlainHeld = PlainReason extends infer R ? (R extends PlainReason ? PlainOf<R> : never) : never;
type PlainReason = Exclude<HeldReason, "limit" | "auth" | "flagged">;
type PlainOf<R extends PlainReason> = HeldBase & None<LimitOwn & { move: unknown; onto: unknown }> & None<AuthOwn> & None<FlaggedOwn> & { readonly reason: R };
