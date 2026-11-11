import type { AgentErrorCode } from "../events/agent-events.js";

/* WHAT EACH FAILURE CODE IS, ONCE: the kind a reader names it by and what becomes of the turn it ended. Five places used
   to classify the codes by hand (the door set here, the board's kinds, the chat's switch, the daemon's hold, the record's
   ending) and they disagreed: the board called a refusal "Held" that the chat drew as a crash, and a turn that hit its
   own ceiling was held by nobody, so no window offered to carry it on and people typed "Continue" by hand (2026-11).
   Every one of them now reads this table, and a code added to the wire fails the build here until it has a row. */

// What kind of failure ended a turn, as the reader acts on it: the board's corner names the kind, and the chat's notice
// leads a provider's words with the kind's own line. Grouped by what the reader does next, not by provider; a failure
// nothing coded has no kind, and each surface says so in its own words.
export type FailureKind =
    // The account signs in but is refused service: an organization or plan that switched it off.
    | "access"
    // The account's credential is dead or missing; a reconnect fixes it.
    | "signedOut"
    // The provider failed and kept failing past the retries.
    | "outage"
    // The model the turn named is not served to this account, or cannot run this kind of turn.
    | "model"
    // The turn is bigger than the model's window.
    | "contextFull"
    // The installed engine is older than the model requires.
    | "update"
    // The provider's safety classifier stopped the turn.
    | "flagged"
    // A spent allowance the `rate_limit` code does not cover (the free trial's day).
    | "limit"
    // The privacy shield held the words back before anything was read.
    | "privacy"
    // Held at the door for want of room, as a memory hold is.
    | "held"
    // The runtime stopped partway without failing outright; the work may be half done.
    | "cutShort"
    // The harness read the message as a slash command it does not have; the model never saw it.
    | "command"
    // The runtime warned about a turn it went on with: a note, not an ending.
    | "advisory";

// What becomes of the turn a failure ended, which the daemon's hold and every window's offer both read.
export type FailureCourse =
    // Refused before the model saw a word: nothing ran, and the words wait in the conversation's queue (or with the
    // sandbox that started the turn) for whatever lets them through.
    | "door"
    // A spent allowance: held for its reopen, or for another account.
    | "limit"
    // The provider failing transiently: held for the breaker's next retry.
    | "outage"
    // A Claude token refused mid-turn: held while the daemon re-mints it, then re-run.
    | "remint"
    // The session outgrew the model's window: re-run once in a fresh session.
    | "overflow"
    // The provider's safety classifier stopped it: held for a person to choose the way on each time.
    | "flagged"
    // Stopped partway with nothing to repair: held whole for a person's press (Continue), since the next move is theirs.
    | "carry"
    // Nothing is held: what is left is the person's next message, or a fix outside the conversation.
    | "bare"
    // A warning about a turn that went on, not an ending.
    | "note";

export interface FailureTraits {
    readonly kind: FailureKind;
    readonly course: FailureCourse;
    // A refusal about the model itself (its allowance, its account, its catalogue, its window), which another model gets
    // past: a turn one of these stops partway offers to carry on elsewhere rather than to wait.
    readonly anotherModelClears?: true;
    // Sending the same turn again fails the same way until something outside it is repaired: no press offers a retry as
    // the way on, and the chat offers the ways out instead (2026-11-05: a person pressed Continue twenty times into one).
    readonly repeats?: true;
}

// Every code the wire names, with its kind and its course. The privacy shield's own refusals (privacy-egress.ts
// isPrivacyRefusal) are all the privacy kind and all turned away at the door.
export const FAILURE_CODES = {
    // The session vanished mid-turn: the next send starts fresh.
    "session-not-found": { kind: "cutShort", course: "bare" },
    rate_limit: { kind: "limit", course: "limit" },
    "codex-advisory": { kind: "advisory", course: "note" },
    "codex-reauth": { kind: "signedOut", course: "bare" },
    // Only the agent's own login command signs it in: nothing a press could re-run would get past it.
    "acp-auth-required": { kind: "signedOut", course: "bare" },
    "claude-reauth": { kind: "signedOut", course: "door" },
    "claude-token-refused": { kind: "signedOut", course: "remint" },
    // An organisation turned the account's Claude Code access off, or no account of the provider can serve: the next
    // turn is routed off it (the daemon's blocked-account route), so the words wait for it rather than being spent.
    "claude-not-entitled": { kind: "access", course: "door", anotherModelClears: true },
    "account-not-entitled": { kind: "access", course: "bare" },
    // The people this conversation works for may not spend the account the turn would run on.
    "account-not-allowed": { kind: "access", course: "door", anotherModelClears: true },
    "provider-outage": { kind: "outage", course: "outage" },
    "trial-unavailable": { kind: "outage", course: "door", anotherModelClears: true },
    "trial-model-unavailable": { kind: "model", course: "door", anotherModelClears: true },
    "trial-exhausted": { kind: "limit", course: "door", anotherModelClears: true },
    "unknown-command": { kind: "command", course: "door" },
    "grok-model-invalid": { kind: "model", course: "bare" },
    "codex-model-invalid": { kind: "model", course: "bare" },
    "model-unavailable": { kind: "model", course: "door", anotherModelClears: true },
    "context-window-too-small": { kind: "contextFull", course: "door", anotherModelClears: true },
    "model-helper-only": { kind: "model", course: "door", anotherModelClears: true },
    // The endpoint the turn would run on is no longer connected. Not `repeats`: that names a wall no other model gets
    // past (wayOut.ts), and this one any other model does.
    "endpoint-gone": { kind: "model", course: "door", anotherModelClears: true },
    // The privacy shield refused an untrusted provider on a runtime it cannot read by content at all.
    "privacy-unshielded": { kind: "privacy", course: "door" },
    // The turn carries a tool list its runtime cannot keep.
    "tools-unenforced": { kind: "held", course: "door" },
    // The protected execution boundary refused admission, not an executed provider/runtime failure.
    "agent-domain-refused": { kind: "held", course: "door" },
    standby: { kind: "held", course: "door" },
    // The privacy shield found personal data in instructions a runtime loads itself, where it could not mask them.
    "privacy-instructions": { kind: "privacy", course: "door" },
    "context-overflow": { kind: "contextFull", course: "overflow" },
    "subscription-required": { kind: "access", course: "bare" },
    "agent-busy": { kind: "held", course: "bare" },
    "sandbox-memory-low": { kind: "held", course: "door" },
    // The conversation's own view of the workspace could not be set up in time: nothing was started in it.
    "workspace-setup": { kind: "held", course: "door" },
    // The conversation's own view of the workspace failed with an error of its own, past the sandbox's one repair.
    "workspace-broken": { kind: "held", course: "door", repeats: true },
    "sandbox-disk-low": { kind: "held", course: "door" },
    // The turn reached its own iteration or time ceiling, its work perhaps half done: carried on by a press, never by a
    // clock, since a re-run on a timer is the runaway the ceiling exists to stop.
    "turn-cap": { kind: "cutShort", course: "carry" },
    "harness-incomplete": { kind: "cutShort", course: "carry" },
    "engine-version-floor": { kind: "update", course: "door" },
    "safeguard-flagged": { kind: "flagged", course: "flagged" },
} as const satisfies Record<AgentErrorCode, FailureTraits>;

// Looked up by a bare string, since a roster row and a stored ending carry the code as one: a newer sandbox's code this
// build has no row for reads as unknown, never as a wrong one, and never as an object prototype's own member.
const TRAITS_OF_CODE: ReadonlyMap<string, FailureTraits> = new Map(Object.entries(FAILURE_CODES));

/** What a failure code is; undefined for no code, and for a code this build does not know. */
export const failureTraitsOf = (code: string | undefined): FailureTraits | undefined => (code === undefined ? undefined : TRAITS_OF_CODE.get(code));

/**
 * What becomes of the turn a failure ended. A failure nothing coded is a turn that stopped short with nothing named to
 * repair, so it is carried on; a code this build does not know holds nothing, since nothing here knows what it would take.
 */
export const failureCourseOf = (code: string | undefined): FailureCourse => {
    if (code === undefined) {
        return "carry";
    }
    return failureTraitsOf(code)?.course ?? "bare";
};

/* THE REFUSALS THAT TURN A WHOLE TURN AWAY AT THE DOOR: refused before the model saw a word, so nothing ran and the
   message is still owed to somebody — the conversation's queue, held, for words a person sent, or the sandbox that
   started the turn itself. Which codes those are is the failure table's to say (failure-codes.ts, the `door` course). */

// The codes whose traits say `test`, as a set: what they share is a fact about the turn, not a shape.
const codesWhere = (test: (traits: FailureTraits) => boolean): ReadonlySet<string> =>
    new Set(Object.entries(FAILURE_CODES).flatMap(([code, traits]: [string, FailureTraits]) => (test(traits) ? [code] : [])));

const TURNED_AWAY = codesWhere((traits) => traits.course === "door");

// The refusals about the model itself (its allowance, its account, its catalogue, its window), which another model
// gets past: a turn one of these stops partway offers to carry on elsewhere rather than to wait.
const ANOTHER_MODEL_CLEARS = codesWhere((traits) => traits.anotherModelClears === true);

/** Whether another model would get past a refusal: the trial's, the model's, or the account's on it. */
export const anotherModelClears = (code: string | undefined): boolean => code !== undefined && ANOTHER_MODEL_CLEARS.has(code);

/** Whether a failure code refuses a turn before the model sees any of it. */
export const turnedAwayCode = (code: string | undefined): boolean => code !== undefined && TURNED_AWAY.has(code);

const REPEATS = codesWhere((traits) => traits.repeats === true);

/** Whether sending the turn again fails the same way until something outside it is repaired. */
export const repeatsUntilRepaired = (code: string | undefined): boolean => code !== undefined && REPEATS.has(code);

/* THE SAME FAILURE AGAIN. Two failures are one when they would read as one: the same code, and for words nobody coded
   the same sentence once what changes from attempt to attempt is taken out (a descriptor bwrap opened, a pid, a port, a
   temp dir's random suffix, a timestamp). The words are the stored ending's, already one bounded line (turn-failure.ts
   sanitizeFailure), so two copies of one failure differ only in those. */

// Hex and decimal runs, with what joins them (`/proc/self/fd/6`, `0x7f3a…`, `12:04:31`, `sandbox-3fa9c1d2`).
const VARYING = /(?:0x)?[0-9a-f]*\d[0-9a-f]*/giu;
// Enough of a sentence to tell two failures apart; past it, a long one is the same failure with a longer tail.
const FINGERPRINT_LENGTH = 160;

/** What two failures share when they are the same failure again: the code, and the words without what varies. */
export const failureFingerprint = (code: string | undefined, message: string | undefined): string => {
    const words = (message ?? "").toLowerCase().replaceAll(VARYING, "#").replaceAll(/\s+/gu, " ").trim().slice(0, FINGERPRINT_LENGTH);
    return `${code ?? ""}|${words}`;
};
