// What the next Send press means: one decision made once, read by the placeholder, tooltip, refusal
// line and submit() so they can't disagree. Pure and value-typed, no refs, no conversation, no
// daemon, so precedence is testable without mounting a chat.
import type { TooltipValue } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import { type SendBlock, sendBlockLine, sendBlockTitle } from "../../../models/providers/sendAvailability";

// Press precedence: place (agent voice, no turn), edit (rewind), plan (revise), later (explicit booking), scheduled (wait for allowance).
// Then idle sends; parked queues behind a live question/card, including one known to the roster before this window draws it.
// Finally steer sends mid-turn input when supported, otherwise queue waits for the turn to end.
// Explicit later bookings win even during a running turn; spent-account scheduled sends never contact the provider before reopening.
export type SendIntent = `place` | `edit` | `plan` | `later` | `scheduled` | `idle` | `parked` | `steer` | `queue`;

// A stopped turn's instants, already resolved to booleans by the pane (which owns the clock), since a
// pure predicate can't read time itself. `ready` is the only thing separating an offer from a countdown.
export interface PickUpSituation {
    readonly ready: boolean;
    /**
     * What a bare press does with this turn while the account it would run on is spent (`spentUntil`): `book` puts a
     * continuation in the queue for the reopen, `arm` sets the limit answer that sends the held turn again then, `armed`
     * says that answer is already set and the press has nothing left to do. Undefined where neither can work (a flagged
     * turn, which only its own card re-runs; a sandbox that cannot book), so the bare press does nothing there.
     */
    readonly atReopen?: ReopenPress | `armed` | undefined;
}

/** What a bare press does for a stopped turn on a spent account: book its continuation, or arm the held turn's resend. */
export type ReopenPress = `book` | `arm`;

/** Everything the four answers turn on, as plain values, one snapshot of the composer and its conversation. */
export interface ComposerSituation {
    /** Words or files in the box: the ordinary reason a press sends anything at all. */
    readonly staged: boolean;
    /** At least one file staged; an attachment is something the user hands over, so it refuses the agent's voice. */
    readonly attached: boolean;
    /** A staged file whose bytes are still going up. */
    readonly uploading: boolean;
    /** A staged file that never landed. */
    readonly uploadFailed: boolean;
    /** The agent's voice is armed (the composer writes as the agent, not to it). */
    readonly voiceAgent: boolean;
    /** A message in this transcript is armed for replacement. */
    readonly editing: boolean;
    /** A plan is on screen awaiting approval or feedback. */
    readonly pendingPlan: boolean;
    /** A turn is live. */
    readonly streaming: boolean;
    /** That live turn is parked on a card (plan, question, permission). */
    readonly awaitingDecision: boolean;
    /** The agents list says this chat waits on a person, whether or not this window has drawn the card yet. */
    readonly waitingOnYou: boolean;
    /** That live turn takes mid-turn input. */
    readonly steerable: boolean;
    /** The last turn stopped before it finished, as the pane reads it against the clock (see PickUpSituation). */
    readonly pickUp: PickUpSituation | undefined;
    /** Messages written mid-turn that haven't reached the agent yet. */
    readonly queued: number;
    /**
     * Those messages are a scheduled send, waiting for their instant: an empty press does not let them go, since the
     * button reads as a time and not as "now"; the held bubble's own Send now does.
     */
    readonly queueScheduled?: boolean;
    /** There is an account to send with. */
    readonly connected: boolean;
    /** The reader picked when the next message goes, a time or another agent's land (sendLater.ts), and may book it. */
    readonly later?: boolean;
    /**
     * When the account the next turn runs on reopens (ms), set only while it reads spent with a reopen still ahead, as
     * the pane resolves it against the clock. Exhaustion without a reset is carried separately in accountBlock.
     */
    readonly spentUntil: number | undefined;
    /** A known account block, including exhaustion without a reset; resolved against the pane's clock. */
    readonly accountBlock?: SendBlock | undefined;
}

/** The words a sentence needs filling in, whose model answers, and what an armed edit would cost. */
export interface ComposerWords {
    /** The provider as the app names it on screen. */
    readonly provider: string;
    /** The free trial has no vendor to name: "Ask Free trial…" invites a sentence to a thing, not to somebody. */
    readonly onTrial: boolean;
    /** How many bubbles the armed edit would take with it, the edited prompt included. */
    readonly editDropped: number;
    /**
     * Plain words: a reader who does not write code, or a guest, is talking to an assistant, not to a named coding tool
     * mid-"turn". Absent reads as the developer's words.
     */
    readonly plain?: boolean;
    /** When the spent allowance reopens, as the button and the limit card both say it (pickUpWhen); `scheduled` only. */
    readonly reopens?: string;
    /** A turn already waits on the limit here: it goes first when the allowance reopens, and the booked message after it. */
    readonly followsWaiting?: boolean;
    /** When a message booked for later goes, as its pill says it (a time, or after which agent lands); `later` only. */
    readonly later?: string;
    /**
     * This chat already holds a scheduled message, which an ordinary send lets go with it: only on a sandbox that books
     * the whole queue at once. One that books each message keeps every booking on its time.
     */
    readonly heldGoesToo?: boolean;
}

export const sendIntentOf = (situation: ComposerSituation): SendIntent => {
    if (situation.voiceAgent) {
        return `place`;
    }
    if (situation.editing) {
        return `edit`;
    }
    if (situation.pendingPlan) {
        return `plan`;
    }
    if (situation.later === true) {
        return `later`;
    }
    if (!situation.streaming) {
        if (situation.waitingOnYou) {
            return `parked`;
        }
        return situation.spentUntil === undefined ? `idle` : `scheduled`;
    }
    if (situation.awaitingDecision) {
        return `parked`;
    }
    return situation.steerable ? `steer` : `queue`;
};

// Plan and edit are separate entries: while a plan is pending, an armed edit still reads for what it is.
// Every entry is a FUNCTION, never a string built at import: `t` reads the active language from a ref, so a table
// evaluated once at module load would hold the words it was born with and never hear the language change.
const PLACEHOLDER: Record<SendIntent, (words: ComposerWords) => string> = {
    place: (words) => t(`chat.composerIntent.placeholderPlace`, { provider: words.provider }),
    // Read only once the box is cleared, exactly when "what was I doing?" needs answering.
    edit: (words) => (words.plain === true ? t(`chat.composerIntent.plain.placeholderEdit`) : t(`chat.composerIntent.placeholderEdit`)),
    // Says what typing does here, since a reply that reads like consent ("go ahead") would otherwise look like approval.
    plan: () => t(`chat.composerIntent.placeholderPlan`),
    // When it goes is on the pill and the button already; the box only says this message is the one being booked.
    later: () => t(`chat.composerIntent.placeholderLater`),
    scheduled: (words) => t(`chat.composerIntent.placeholderScheduled`, { when: words.reopens ?? `` }),
    idle: (words) =>
        words.plain === true
            ? t(`chat.composerIntent.plain.placeholderIdle`)
            : words.onTrial
              ? t(`chat.words.askAnything`)
              : t(`chat.composerIntent.placeholderIdle`, { provider: words.provider }),
    parked: () => t(`chat.composerIntent.placeholderParked`),
    steer: (words) =>
        words.plain === true ? t(`chat.composerIntent.plain.placeholderSteer`) : t(`chat.composerIntent.placeholderSteer`, { provider: words.provider }),
    queue: (words) => (words.plain === true ? t(`chat.composerIntent.plain.placeholderQueue`) : t(`chat.composerIntent.placeholderQueue`)),
};

// The Send button's hover: a label, or a small card where the press has a fact or a consequence worth a glance.
const SEND_HINT: Record<SendIntent, (words: ComposerWords) => TooltipValue> = {
    place: (words) => ({ title: t(`chat.composerIntent.hintPlace`, { provider: words.provider }), note: t(`chat.composerIntent.noReply`) }),
    // Names the cost, a count only where more than the edited prompt itself goes.
    edit: (words) =>
        words.editDropped <= 1
            ? t(`chat.composerIntent.hintEditOne`)
            : { title: t(`chat.composerIntent.hintEditOne`), rows: [{ label: t(`chat.composerIntent.alsoReplaced`), value: words.editDropped - 1 }] },
    plan: () => ({ title: t(`chat.composerIntent.hintPlan`), note: t(`chat.composerIntent.hintPlanNote`) }),
    // When it goes, and that it can still be sent sooner, re-timed or taken back from where it waits.
    later: (words) => ({
        title: t(`chat.composerIntent.hintLater`),
        rows: [{ label: t(`chat.composerIntent.sendsAt`), value: words.later ?? `` }],
        note: t(`chat.composerIntent.hintLaterNote`),
    }),
    // Promises the one thing the sandbox guarantees: nothing goes before the reopen, unless the reader says so.
    scheduled: (words) => ({
        title: t(`chat.composerIntent.hintScheduled`),
        rows: [{ label: t(`chat.composerIntent.sendsAt`), value: words.reopens ?? `` }],
        note: words.followsWaiting === true ? t(`chat.composerIntent.hintScheduledAfter`) : t(`chat.composerIntent.hintScheduledHeld`),
    }),
    // An ordinary send lets go what this chat holds scheduled, as any send to a held queue does: said before the press.
    idle: (words) =>
        words.heldGoesToo === true
            ? { title: t(`chat.composerIntent.hintIdle`), note: t(`chat.composerIntent.hintIdleScheduled`) }
            : t(`chat.composerIntent.hintIdle`),
    // Says whether Send reaches the running turn or waits, so identical buttons don't mean different things.
    parked: () => ({ title: t(`chat.composerIntent.queue`), note: t(`chat.composerIntent.hintParked`) }),
    steer: (words) => (words.plain === true ? t(`chat.composerIntent.plain.hintSteer`) : t(`chat.composerIntent.hintSteer`)),
    queue: (words) => ({
        title: t(`chat.composerIntent.queue`),
        note: words.plain === true ? t(`chat.composerIntent.plain.hintQueue`) : t(`chat.composerIntent.hintQueue`),
    }),
};

/**
 * A chat with nothing to send with. The box still takes the task — it is what a first-run reader came to write — and
 * neither line names a vendor, since nothing has been chosen for one to be named. Send is disabled there and says why
 * (unconnectedHint); the draft waits, so the sentence already typed is what the model, once connected, answers.
 */
export const unconnectedPlaceholder = (): string => t(`chat.composerIntent.unconnectedPlaceholder`);

/**
 * The disabled Send's reason, as the one fix: connect a model, or, where something else in the sandbox runs, choose it.
 * Never a press of its own (2026-10-25): Send used to open the model list here, a fourth door to it beside the notice's
 * two and the pill, and a Send that does something other than send. A model `withheld` from the reader (Access ▸
 * People) is not connected's case: choosing one of theirs, or asking the owner, is the fix, never connecting.
 */
export const unconnectedHint = (othersReady: boolean, withheld = false): TooltipValue => {
    if (withheld) {
        return { title: t(`chat.composerIntent.notSharedHint`), note: othersReady ? t(`chat.composerIntent.notSharedNote`) : t(`chat.composerIntent.askOwnerNote`) };
    }
    return othersReady
        ? { title: t(`chat.composerIntent.otherModelHint`), note: t(`chat.composerIntent.otherModelNote`) }
        : { title: t(`chat.composerIntent.unconnectedHint`), note: t(`chat.composerIntent.unconnectedNote`) };
};

export const placeholderFor = (intent: SendIntent, words: ComposerWords): string => PLACEHOLDER[intent](words);

export const sendHintFor = (intent: SendIntent, words: ComposerWords): TooltipValue => SEND_HINT[intent](words);

// What stops Send, one name per rule; worded twice below, as the status line's sentence and the button's short label.
type Refusal = SendBlock | `runningPlace` | `planPending` | `attachedVoice` | `runningEdit` | `uploading` | `uploadFailed`;

// Only an edit or a fresh immediate turn needs the selected account to be available. Live feedback,
// explicit bookings and words placed as the agent do not start a turn on it. An edit is refused outright: it rewinds
// the transcript before the provider answers, so a refusal there would cost messages.
const accountRefusalOf = (situation: ComposerSituation): SendBlock | undefined => {
    if (situation.voiceAgent || !situation.editing) {
        return undefined;
    }
    return situation.accountBlock ?? (situation.spentUntil === undefined ? undefined : `editSpent`);
};

// A fresh turn on an account that READS blocked is a warning, not a refusal (2026-10-26): the reading lags the provider
// (a seat taken away and given back, an allowance read wrong), and the provider has the last word. The press then sends
// anyway, naming the account so the daemon tries it rather than holding or moving the turn; a refused try costs nothing,
// the message stays in the transcript with the provider's own reason.
const accountCautionOf = (situation: ComposerSituation): SendBlock | undefined => {
    if (situation.voiceAgent || situation.editing || situation.streaming || situation.pendingPlan || situation.later === true) {
        return undefined;
    }
    return situation.accountBlock;
};

const refusalOf = (situation: ComposerSituation): Refusal | undefined => {
    const account = accountRefusalOf(situation);
    if (account !== undefined) {
        return account;
    }
    if (!situation.staged) {
        // Nothing staged is not a refusal, an empty composer explains itself.
        return undefined;
    }
    // The agent's voice refuses more than your own, stating the daemon's rule before a failed round-trip.
    if (situation.voiceAgent) {
        if (situation.streaming) {
            return `runningPlace`;
        }
        if (situation.pendingPlan) {
            return `planPending`;
        }
        if (situation.attached) {
            return `attachedVoice`;
        }
    }
    // A rewind is refused while a turn holds the conversation; said here rather than by a silently greyed
    // button.
    if (situation.editing && situation.streaming) {
        return `runningEdit`;
    }
    if (situation.uploading) {
        return `uploading`;
    }
    if (situation.uploadFailed) {
        return `uploadFailed`;
    }
    return undefined;
};

const REFUSAL_LINE = {
    spent: () => sendBlockLine(`spent`),
    editSpent: () => sendBlockLine(`editSpent`),
    reconnect: () => sendBlockLine(`reconnect`),
    admin: () => sendBlockLine(`admin`),
    verify: () => sendBlockLine(`verify`),
    wait: () => sendBlockLine(`wait`),
    runningPlace: () => t(`chat.composerIntent.refusalRunningPlace`),
    planPending: () => t(`chat.composerIntent.refusalPlanPending`),
    attachedVoice: () => t(`chat.composerIntent.refusalAttachedVoice`),
    runningEdit: () => t(`chat.composerIntent.refusalRunningEdit`),
    uploading: () => t(`chat.composerIntent.refusalUploading`),
    uploadFailed: () => t(`chat.composerIntent.refusalUploadFailed`),
} satisfies Record<Refusal, () => string>;

const REFUSAL_TITLE = {
    spent: () => sendBlockTitle(`spent`),
    editSpent: () => sendBlockTitle(`editSpent`),
    reconnect: () => sendBlockTitle(`reconnect`),
    admin: () => sendBlockTitle(`admin`),
    verify: () => sendBlockTitle(`verify`),
    wait: () => sendBlockTitle(`wait`),
    runningPlace: () => t(`chat.composerIntent.refusedRunning`),
    planPending: () => t(`chat.composerIntent.refusedPlan`),
    attachedVoice: () => t(`chat.composerIntent.refusedAttached`),
    runningEdit: () => t(`chat.composerIntent.refusedRunning`),
    uploading: () => t(`chat.composerIntent.refusedUploading`),
    uploadFailed: () => t(`chat.composerIntent.refusedUploadFailed`),
} satisfies Record<Refusal, () => string>;

// Why Send is refusing, in the user's words; undefined when the press will land. Anything refused
// must name itself, since nothing else on screen shows a cause.
export const sendRefusal = (situation: ComposerSituation): string | undefined => {
    const refusal = refusalOf(situation);
    return refusal === undefined ? undefined : REFUSAL_LINE[refusal]();
};

// The same refusal as the greyed button's hover, a word or two: the sentence is the status line's.
export const sendRefusalTitle = (situation: ComposerSituation): string | undefined => {
    const refusal = refusalOf(situation);
    return refusal === undefined ? undefined : REFUSAL_TITLE[refusal]();
};

/**
 * The block a press would send past: set while the box holds something, nothing else refuses, and the account the turn
 * runs on reads blocked. The press then reads as "Send anyway" and names the account (composerSend's submit).
 */
export const sendAnyway = (situation: ComposerSituation): SendBlock | undefined =>
    situation.staged && refusalOf(situation) === undefined ? accountCautionOf(situation) : undefined;

// What the status line says while the press would send anyway: the reading, and that Send tries the account regardless.
export const sendAnywayLine = (block: SendBlock): string => t(`chat.composerIntent.anywayLine`, { reading: sendBlockTitle(block) });

// The Send button's hover in that state.
export const sendAnywayHint = (block: SendBlock): TooltipValue => ({
    title: t(`chat.composerIntent.hintAnyway`),
    tone: `warning`,
    rows: [{ label: t(`chat.composerIntent.lastReading`), value: sendBlockTitle(block) }],
    note: t(`chat.composerIntent.hintAnywayNote`),
});

// The last turn stopped, but staged words/files, a pending plan, or a queued message mean saying so
// would be wrong. Visible is the strip; offered is the bare press continuing it NOW, which additionally requires
// `pickUp.ready` and an account with room: on a spent one the press is refused before anything runs, so the bare press
// there means "continue at the reopen" instead (reopenPressOf), which is what the time-labelled button beside it says.
export const continueVisible = (situation: ComposerSituation): boolean =>
    situation.pickUp !== undefined && !situation.staged && situation.queued === 0 && !situation.pendingPlan && situation.connected;

// A blocked reading still keeps the bare Continue back: only a press on words in the box sends anyway.
export const continueOffered = (situation: ComposerSituation): boolean =>
    continueVisible(situation) &&
    situation.pickUp?.ready === true &&
    situation.spentUntil === undefined &&
    situation.accountBlock === undefined &&
    refusalOf(situation) === undefined;

/**
 * What a bare press does for a stopped turn while the account is spent with a reopen ahead: book its continuation for
 * then, or set the held turn's limit answer to send it again then. Undefined when the press has nothing to do: no turn
 * to continue, room on the account (continueOffered), an answer already set, or a turn only its own card re-runs.
 */
export const reopenPressOf = (situation: ComposerSituation): ReopenPress | undefined => {
    const press = situation.pickUp?.atReopen;
    return continueVisible(situation) && situation.spentUntil !== undefined && (press === `book` || press === `arm`) ? press : undefined;
};

/** The scheduled button's hover on an empty box with a turn to continue: what it books, when, or that it is booked. */
export const reopenHintFor = (press: ReopenPress | `armed`, words: ComposerWords): TooltipValue => {
    const rows = [{ label: t(`chat.composerIntent.sendsAt`), value: words.reopens ?? `` }];
    switch (press) {
        case `book`:
            return { title: t(`chat.composerIntent.hintContinueAtReopen`), rows, note: t(`chat.composerIntent.hintContinueAtReopenNote`) };
        case `arm`:
            return { title: t(`chat.composerIntent.hintSendAgainAtReopen`), rows, note: t(`chat.composerIntent.hintSendAgainAtReopenNote`) };
        default:
            return { title: t(`chat.composerIntent.hintGoesAtReopen`), rows, note: t(`chat.composerIntent.hintGoesAtReopenNote`) };
    }
};

// A bare press with nothing typed, sending the messages written while the agent was busy. Not on an account that reads
// blocked: those messages name no account, so only words sent from the box go anyway (sendAnyway).
const queueFlushable = (situation: ComposerSituation): boolean =>
    situation.queued > 0 &&
    !situation.streaming &&
    !situation.pendingPlan &&
    situation.queueScheduled !== true &&
    accountCautionOf(situation) === undefined;

// Whether the press lands at all; a mid-turn message is never refused; only whether there's something
// to send and something stopping it.
export const sendable = (situation: ComposerSituation, intent: SendIntent, refusal: string | undefined): boolean => {
    if (refusal !== undefined) {
        return false;
    }
    // Place and edit both need words in the box; empty would silently rewind without asking anything. A booked send
    // does too: its button reads as a time, so a bare press meaning "Continue now" (or "flush the queue now") would do
    // the opposite of what it says. A scheduled one alike, except that a stopped turn waiting gives its bare press the
    // meaning its label already states: continue at the reopen (reopenPressOf).
    if (intent === `scheduled`) {
        return situation.staged || reopenPressOf(situation) !== undefined;
    }
    if (intent === `place` || intent === `edit` || intent === `later`) {
        return situation.staged;
    }
    return situation.staged || continueOffered(situation) || queueFlushable(situation);
};
