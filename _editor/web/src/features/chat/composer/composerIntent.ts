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
//  - `scheduled`, nothing is running but the account the turn would run on is spent: the send is booked, not tried. The
//    words wait in the conversation's queue, drawn as scheduled, and the sandbox lets them go when the allowance
//    reopens; nothing reaches the provider before, so there is no refusal to show for a wait the reader chose knowingly.
//  - `idle`, nothing is running: the ordinary send.
//  - `parked`, a turn is live but stopped on a card: the message waits for the card to be answered. Also a chat the
//    agents list says waits on a person while this window has not drawn the card yet: the composer must not read as
//    idle over an agent that has been waiting for an answer.
//  - `steer`, a live turn takes mid-turn input: the message reaches the turn already running.
//  - `queue`, a live turn that doesn't: the message waits for it to end.
export type SendIntent = `place` | `edit` | `plan` | `scheduled` | `idle` | `parked` | `steer` | `queue`;

// A stopped turn's instants, already resolved to booleans by the pane (which owns the clock), since a
// pure predicate can't read time itself. `ready` is the only thing separating an offer from a countdown.
export interface PickUpSituation {
    readonly ready: boolean;
}

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
    /** When the spent allowance reopens, as the button and the limit card both say it (pickUpWhen); `scheduled` only. */
    readonly reopens?: string;
    /** A turn already waits on the limit here: it goes first when the allowance reopens, and the booked message after it. */
    readonly followsWaiting?: boolean;
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
    edit: () => t(`chat.composerIntent.placeholderEdit`),
    // Says what typing does here, since a reply that reads like consent ("go ahead") would otherwise look like approval.
    plan: () => t(`chat.composerIntent.placeholderPlan`),
    scheduled: (words) => t(`chat.composerIntent.placeholderScheduled`, { when: words.reopens ?? `` }),
    idle: (words) => (words.onTrial ? t(`chat.words.askAnything`) : t(`chat.composerIntent.placeholderIdle`, { provider: words.provider })),
    parked: () => t(`chat.composerIntent.placeholderParked`),
    steer: (words) => t(`chat.composerIntent.placeholderSteer`, { provider: words.provider }),
    queue: () => t(`chat.composerIntent.placeholderQueue`),
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
    // Promises the one thing the sandbox guarantees: nothing goes before the reopen, unless the reader says so.
    scheduled: (words) => ({
        title: t(`chat.composerIntent.hintScheduled`),
        rows: [{ label: t(`chat.composerIntent.sendsAt`), value: words.reopens ?? `` }],
        note: words.followsWaiting === true ? t(`chat.composerIntent.hintScheduledAfter`) : t(`chat.composerIntent.hintScheduledHeld`),
    }),
    idle: () => t(`chat.composerIntent.hintIdle`),
    // Says whether Send reaches the running turn or waits, so identical buttons don't mean different things.
    parked: () => ({ title: t(`chat.composerIntent.queue`), note: t(`chat.composerIntent.hintParked`) }),
    steer: () => t(`chat.composerIntent.hintSteer`),
    queue: () => ({ title: t(`chat.composerIntent.queue`), note: t(`chat.composerIntent.hintQueue`) }),
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
// would be wrong. Visible is the strip; offered is the press, which additionally requires
// `pickUp.ready`.
export const continueVisible = (situation: ComposerSituation): boolean =>
    situation.pickUp !== undefined && !situation.staged && situation.queued === 0 && !situation.pendingPlan && situation.connected;

export const continueOffered = (situation: ComposerSituation): boolean => continueVisible(situation) && situation.pickUp?.ready === true;

// A bare press with nothing typed, sending the messages written while the agent was busy.
const queueFlushable = (situation: ComposerSituation): boolean =>
    situation.queued > 0 && !situation.streaming && !situation.pendingPlan && situation.queueScheduled !== true;

// Whether the press lands at all; a mid-turn message is never refused; only whether there's something
// to send and something stopping it.
export const sendable = (situation: ComposerSituation, intent: SendIntent, refusal: string | undefined): boolean => {
    if (refusal !== undefined) {
        return false;
    }
    // Place and edit both need words in the box; empty would silently rewind without asking anything.
    if (intent === `place` || intent === `edit`) {
        return situation.staged;
    }
    return situation.staged || continueOffered(situation) || queueFlushable(situation);
};
