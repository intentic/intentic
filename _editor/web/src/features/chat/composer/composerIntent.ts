// What the next Send press means: one decision made once, read by the placeholder, tooltip, refusal
// line and submit() so they can't disagree. Pure and value-typed, no refs, no conversation, no
// daemon, so precedence is testable without mounting a chat.
import { t } from "@intentic/ui/i18n";

// The intents, in the order they claim the press.
//
//  - `place`, the agent's voice is armed: words go into the transcript as the agent's own, no turn.
//  - `edit`, a message is being replaced: the send rewinds to it and asks again.
//  - `plan`, a plan is waiting on an answer: typing revises it rather than starting anything.
//  - `idle`, nothing is running: the ordinary send.
//  - `parked`, a turn is live but stopped on a card: the message waits for the card to be answered.
//  - `steer`, a live turn takes mid-turn input: the message reaches the turn already running.
//  - `queue`, a live turn that doesn't: the message waits for it to end.
export type SendIntent = `place` | `edit` | `plan` | `idle` | `parked` | `steer` | `queue`;

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
    /** That live turn takes mid-turn input. */
    readonly steerable: boolean;
    /** The last turn stopped before it finished, as the pane reads it against the clock (see PickUpSituation). */
    readonly pickUp: PickUpSituation | undefined;
    /** Messages written mid-turn that haven't reached the agent yet. */
    readonly queued: number;
    /** There is an account to send with. */
    readonly connected: boolean;
}

/** The words a sentence needs filling in, whose model answers, and what an armed edit would cost. */
export interface ComposerWords {
    /** The provider as the app names it on screen. */
    readonly provider: string;
    /** The free trial has no vendor to name: "Ask Free trial…" invites a sentence to a thing, not to somebody. */
    readonly onTrial: boolean;
    /** How many bubbles the armed edit would take with it, the edited prompt included. */
    readonly editDropped: number;
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
        return `idle`;
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
    plan: () => t(`chat.composerIntent.placeholderPlan`),
    idle: (words) =>
        words.onTrial ? t(`chat.composerIntent.placeholderIdleTrial`) : t(`chat.composerIntent.placeholderIdle`, { provider: words.provider }),
    parked: () => t(`chat.composerIntent.placeholderParked`),
    steer: (words) => t(`chat.composerIntent.placeholderSteer`, { provider: words.provider }),
    queue: () => t(`chat.composerIntent.placeholderQueue`),
};

const SEND_HINT: Record<SendIntent, (words: ComposerWords) => string> = {
    place: (words) => t(`chat.composerIntent.hintPlace`, { provider: words.provider }),
    // Names the cost, singular where only the edited prompt itself goes.
    edit: (words) =>
        words.editDropped === 1
            ? t(`chat.composerIntent.hintEditOne`)
            : t(`chat.composerIntent.hintEditMany`, { count: words.editDropped - 1 }, words.editDropped - 1),
    plan: () => t(`chat.composerIntent.hintPlan`),
    idle: () => t(`chat.composerIntent.hintIdle`),
    // Says whether Send reaches the running turn or waits, so identical buttons don't mean different things.
    parked: () => t(`chat.composerIntent.hintParked`),
    steer: () => t(`chat.composerIntent.hintSteer`),
    queue: () => t(`chat.composerIntent.hintQueue`),
};

/**
 * A viewer's composer is present but inert, the daemon floors every turn route at collaborator. A getter rather
 * than a constant, for the same reason the tables above hold functions: a constant would freeze one language in.
 */
export const viewerPlaceholder = (): string => t(`chat.composerIntent.viewerPlaceholder`);

export const placeholderFor = (intent: SendIntent, words: ComposerWords): string => PLACEHOLDER[intent](words);

export const sendHintFor = (intent: SendIntent, words: ComposerWords): string => SEND_HINT[intent](words);

// Why Send is refusing, in the user's words; undefined when the press will land. Anything refused
// must name itself, since nothing else on screen shows a cause.
export const sendRefusal = (situation: ComposerSituation): string | undefined => {
    if (!situation.staged) {
        // Nothing staged is not a refusal, an empty composer explains itself.
        return undefined;
    }
    // The agent's voice refuses more than your own, stating the daemon's rule before a failed round-trip.
    if (situation.voiceAgent) {
        if (situation.streaming) {
            return t(`chat.composerIntent.refusalRunningPlace`);
        }
        if (situation.pendingPlan) {
            return t(`chat.composerIntent.refusalPlanPending`);
        }
        if (situation.attached) {
            return t(`chat.composerIntent.refusalAttachedVoice`);
        }
    }
    // A rewind is refused while a turn holds the conversation; said here rather than by a silently greyed
    // button.
    if (situation.editing && situation.streaming) {
        return t(`chat.composerIntent.refusalRunningEdit`);
    }
    if (situation.uploading) {
        return t(`chat.composerIntent.refusalUploading`);
    }
    if (situation.uploadFailed) {
        return t(`chat.composerIntent.refusalUploadFailed`);
    }
    return undefined;
};

// The last turn stopped, but staged words/files, a pending plan, or a queued message mean saying so
// would be wrong. Visible is the strip; offered is the press, which additionally requires
// `pickUp.ready`.
export const continueVisible = (situation: ComposerSituation): boolean =>
    situation.pickUp !== undefined && !situation.staged && situation.queued === 0 && !situation.pendingPlan && situation.connected;

export const continueOffered = (situation: ComposerSituation): boolean => continueVisible(situation) && situation.pickUp?.ready === true;

// A bare press with nothing typed, sending the messages written while the agent was busy.
const queueFlushable = (situation: ComposerSituation): boolean => situation.queued > 0 && !situation.streaming && !situation.pendingPlan;

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
