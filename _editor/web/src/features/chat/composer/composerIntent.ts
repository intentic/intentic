// What the next Send press means: one decision made once, read by the placeholder, tooltip, refusal
// line and submit() so they can't disagree. Pure and value-typed, no refs, no conversation, no
// daemon, so precedence is testable without mounting a chat.
import type { TooltipValue } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";

// The intents, in the order they claim the press.
//
//  - `place`, the agent's voice is armed: words go into the transcript as the agent's own, no turn.
//  - `edit`, a message is being replaced: the send rewinds to it and asks again.
//  - `plan`, a plan is waiting on an answer: typing revises it rather than starting anything.
//  - `later`, the reader picked when the message goes (sendLater.ts): a time, or once another agent's work has landed.
//    The send is booked whatever this chat is doing, a turn running here included: the words wait in its queue, drawn as
//    scheduled, and go when that comes. The reader chose the moment, so nothing below it decides it instead.
//  - `scheduled`, nothing is running but the account the turn would run on is spent: the send is booked, not tried. The
//    words wait in the conversation's queue, drawn as scheduled, and the sandbox lets them go when the allowance
//    reopens; nothing reaches the provider before, so there is no refusal to show for a wait the reader chose knowingly.
//  - `idle`, nothing is running: the ordinary send.
//  - `parked`, a turn is live but stopped on a card: the message waits for the card to be answered. Also a chat the
//    agents list says waits on a person while this window has not drawn the card yet: the composer must not read as
//    idle over an agent that has been waiting for an answer.
//  - `steer`, a live turn takes mid-turn input: the message reaches the turn already running.
//  - `queue`, a live turn that doesn't: the message waits for it to end.
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
     * the pane resolves it against the clock. Undefined covers every case a plain send is right: room, no reading, a
     * spent pool with no named reset (nothing to book against), or a reset already passed.
     */
    readonly spentUntil: number | undefined;
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
 * A viewer's composer is present but inert, the daemon floors every turn route at collaborator. A getter rather
 * than a constant, for the same reason the tables above hold functions: a constant would freeze one language in.
 */
export const viewerPlaceholder = (): string => t(`chat.composerIntent.viewerPlaceholder`);

/**
 * A chat with nothing to send with. The box still takes the task — it is what a first-run reader came to write — and
 * neither line names a vendor, since nothing has been chosen for one to be named. Send opens the model list from
 * here, keeping the draft, so the sentence already typed is what the chosen model answers.
 */
export const unconnectedPlaceholder = (): string => t(`chat.composerIntent.unconnectedPlaceholder`);

export const unconnectedHint = (): string => t(`chat.composerIntent.unconnectedHint`);

export const placeholderFor = (intent: SendIntent, words: ComposerWords): string => PLACEHOLDER[intent](words);

export const sendHintFor = (intent: SendIntent, words: ComposerWords): TooltipValue => SEND_HINT[intent](words);

// What stops Send, one name per rule; worded twice below, as the status line's sentence and the button's short label.
type Refusal = `runningPlace` | `planPending` | `attachedVoice` | `runningEdit` | `uploading` | `uploadFailed`;

const refusalOf = (situation: ComposerSituation): Refusal | undefined => {
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
    runningPlace: () => t(`chat.composerIntent.refusalRunningPlace`),
    planPending: () => t(`chat.composerIntent.refusalPlanPending`),
    attachedVoice: () => t(`chat.composerIntent.refusalAttachedVoice`),
    runningEdit: () => t(`chat.composerIntent.refusalRunningEdit`),
    uploading: () => t(`chat.composerIntent.refusalUploading`),
    uploadFailed: () => t(`chat.composerIntent.refusalUploadFailed`),
} satisfies Record<Refusal, () => string>;

const REFUSAL_TITLE = {
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

// The last turn stopped, but staged words/files, a pending plan, or a queued message mean saying so
// would be wrong. Visible is the strip; offered is the bare press continuing it NOW, which additionally requires
// `pickUp.ready` and an account with room: on a spent one the press is refused before anything runs, so the bare press
// there means "continue at the reopen" instead (reopenPressOf), which is what the time-labelled button beside it says.
export const continueVisible = (situation: ComposerSituation): boolean =>
    situation.pickUp !== undefined && !situation.staged && situation.queued === 0 && !situation.pendingPlan && situation.connected;

export const continueOffered = (situation: ComposerSituation): boolean =>
    continueVisible(situation) && situation.pickUp?.ready === true && situation.spentUntil === undefined;

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

// A bare press with nothing typed, sending the messages written while the agent was busy.
const queueFlushable = (situation: ComposerSituation): boolean =>
    situation.queued > 0 && !situation.streaming && !situation.pendingPlan && situation.queueScheduled !== true;

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
