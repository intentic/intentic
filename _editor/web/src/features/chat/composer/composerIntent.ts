/* WHAT THE NEXT PRESS OF SEND MEANS, one decision, made once, read by everything that has to agree with it.
 *
 * The composer answers the same question in four places: the placeholder in the empty box, the tooltip on the
 * button, the refusal line under it, and `submit` itself. They used to answer it four times over, each with its
 * own ladder of ifs in its own order, which is how the tooltip and the placeholder came to disagree about a
 * plan awaiting an answer, and how a state added to one of them (the agent's voice, an armed edit) had to be
 * remembered in the other three.
 *
 * So the ladder is climbed ONCE, here, and yields a name. The words are lookups on that name and nothing else,
 * which is what makes them incapable of disagreeing: a new intent is a compile error in every table until it is
 * given a sentence.
 *
 * Pure and value-typed on purpose, no refs, no conversation, no daemon. The pane hands over a snapshot of the
 * situation and gets back the answer, so the whole precedence is testable without mounting a chat. */

/* THE INTENTS, IN THE ORDER THEY CLAIM THE PRESS.
 *
 *  - `place` , the agent's voice is armed: the words go into the transcript as the agent's own, no turn.
 *  - `edit`  , a message is being replaced: the send rewinds to it and asks again.
 *  - `plan`  , a plan is waiting on an answer: typing revises it rather than starting anything.
 *  - `idle`  , nothing is running: the ordinary send.
 *  - `parked`, a turn is live but stopped on a card: the message waits for the card to be answered.
 *  - `steer` , a live turn takes mid-turn input: the message reaches the turn already running.
 *  - `queue` , a live turn that doesn't: the message waits for it to end.
 */
export type SendIntent = `place` | `edit` | `plan` | `idle` | `parked` | `steer` | `queue`;

/* A STOPPED TURN, ALREADY READ AGAINST THE CLOCK. The pick-up itself carries instants (pickUp.ts); this file is
 * pure and value-typed, and a predicate that read the clock would answer differently on two consecutive calls in
 * one render. So the pane, which owns the ticking clock, resolves both instants into booleans and hands those
 * over: `ready` is whether a press gets through NOW, and it is the only thing separating an offer from a
 * countdown. */
export interface PickUpSituation {
    readonly ready: boolean;
}

/** Everything the four answers turn on, as plain values, one snapshot of the composer and its conversation. */
export interface ComposerSituation {
    /** Words or files in the box: the ordinary reason a press sends anything at all. */
    readonly staged: boolean;
    /** At least one file staged, an attachment is a thing the USER hands over, so it refuses the agent's voice. */
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

// While a plan is pending the composer is the revision field, so an armed edit is read for what it is rather
// than for the plan behind it, which is why these are two entries and not one.
const PLACEHOLDER: Record<SendIntent, (words: ComposerWords) => string> = {
    place: (words) => `Write as ${words.provider}, placed into the transcript, no reply…`,
    // An edit arrives with the old prompt already in the box, so this is only ever read once the user has
    // cleared it, which is precisely the moment "what was I doing?" needs answering.
    edit: () => `Ask this turn again, differently…`,
    plan: () => `Reply to revise the plan…`,
    idle: (words) => (words.onTrial ? `Ask anything…` : `Ask ${words.provider}…`),
    parked: () => `Answer above, or add a message for after…`,
    steer: (words) => `Steer ${words.provider} mid-turn…`,
    queue: () => `Add a message for when this turn ends…`,
};

const SEND_HINT: Record<SendIntent, (words: ComposerWords) => string> = {
    place: (words) => `Place into the transcript as ${words.provider}, no reply`,
    // Names the COST, because this is the press that pays it and the count is what the struck rows are on
    // screen to make legible. Singular where only the edited prompt itself goes.
    edit: (words) => (words.editDropped === 1 ? `Replace this message` : `Replace this message and the ${words.editDropped - 1} below it`),
    plan: () => `Send as feedback (keep planning)`,
    idle: () => `Send`,
    // Mid-turn the message either reaches the running turn or waits for it, say which, so a Send that looks
    // identical in both cases doesn't quietly mean two different things.
    parked: () => `Queue for after the request above`,
    steer: () => `Send to the running turn`,
    queue: () => `Queue for when this turn ends`,
};

/** A viewer's composer is present but inert, the daemon floors every turn route at collaborator. */
export const VIEWER_PLACEHOLDER = `You're viewing: ask the owner for a collaborator role to drive agents`;

export const placeholderFor = (intent: SendIntent, words: ComposerWords): string => PLACEHOLDER[intent](words);

export const sendHintFor = (intent: SendIntent, words: ComposerWords): string => SEND_HINT[intent](words);

/* WHY SEND IS REFUSING, in the user's words, undefined when the press will land.
 *
 * Anything the composer refuses has to name itself: an attachment chip looks finished the moment its thumbnail
 * renders, so a message that will not send otherwise has no visible cause anywhere on screen. */
export const sendRefusal = (situation: ComposerSituation): string | undefined => {
    if (!situation.staged) {
        // Nothing staged is not a refusal, an empty composer explains itself.
        return undefined;
    }
    /* The agent's voice refuses more than your own, and each refusal is the daemon's rule said early: a running
     * turn holds the very session placing exists to retire (the route answers CONFLICT), a pending plan is a
     * question the agent is mid-way through asking, and an attachment is a thing the USER hands over, there is
     * no shape of transcript in which the agent attached a file to its own reply. */
    if (situation.voiceAgent) {
        if (situation.streaming) {
            return `The agent is running: its words can be placed once the turn ends.`;
        }
        if (situation.pendingPlan) {
            return `A plan is awaiting your answer: decide it before speaking as the agent.`;
        }
        if (situation.attached) {
            return `An attachment can't be placed as the agent's words: remove it (×) or switch back to your own voice.`;
        }
    }
    /* An edit spends a rewind, and the daemon refuses one while a turn holds the conversation (agent/rewind.ts).
     * Said HERE rather than by greying the button silently: the pencil is only offered on a settled chat, so a
     * user who reaches this state armed an edit and then something started, an auto-continue, a queued message
     * going out, a colleague's press, and the composer is the only thing on screen that can explain why the
     * send it is holding will not land. The edit stays armed; the press works the moment the turn ends. */
    if (situation.editing && situation.streaming) {
        return `The agent is running: this edit can be sent once the turn ends.`;
    }
    if (situation.uploading) {
        return `Waiting for the attachment to finish uploading…`;
    }
    if (situation.uploadFailed) {
        return `An attachment failed to upload: remove it (×) to send.`;
    }
    return undefined;
};

/* THE LAST TURN STOPPED BEFORE IT FINISHED, and this composer has something to say about it.
 *
 * The state itself is the conversation's (Conversation.pickUp, and pickUp.ts for which endings earn it); what
 * the composer adds is the three states in which saying anything would be wrong even though the turn really did
 * stop. An EMPTY BOX is the whole of the gesture, the offer is "press this instead of typing", so the moment
 * there are words or files staged, those are what the user means to send. A PENDING PLAN turns the composer into
 * the revision field, where a continuation would be feedback rather than a continuation. And a QUEUED message is
 * already the answer to "what happens next", waiting for a send of its own.
 *
 * TWO PREDICATES, because a pick-up can be worth a strip before it is worth a press. Visible is the strip: it
 * says what happened and what is being waited for. Offered is the press and the Enter key, which are the same
 * offer wearing two shapes, so they share one predicate exactly: a user who reaches for the key because the strip
 * is on screen must not find it does something else.
 *
 * They now agree far more often than they used to, and deliberately: a turn the daemon is HOLDING is pressable
 * whatever its reset instant says (pickUpReady has the argument, which is that withholding the press only ever
 * sent people to the composer to type the same thing worse). The split survives for the endings with nothing
 * held, where a press really would just append. */
export const continueVisible = (situation: ComposerSituation): boolean =>
    situation.pickUp !== undefined && !situation.staged && situation.queued === 0 && !situation.pendingPlan && situation.connected;

export const continueOffered = (situation: ComposerSituation): boolean => continueVisible(situation) && situation.pickUp?.ready === true;

// A bare press with nothing typed, sending the messages written while the agent was busy.
const queueFlushable = (situation: ComposerSituation): boolean => situation.queued > 0 && !situation.streaming && !situation.pendingPlan;

/* Whether the press lands at all. A message written mid-turn is never refused, it is delivered into the running
 * turn or queued behind it, so this is not about what the conversation is doing; it is about whether there is
 * anything to send and anything stopping it. */
export const sendable = (situation: ComposerSituation, intent: SendIntent, refusal: string | undefined): boolean => {
    if (refusal !== undefined) {
        return false;
    }
    /* The agent's voice sends exactly the words in the box, and an edit replaces a prompt so it needs one: an
     * empty box would drop the turns and then ask nothing, which is a rewind the user did not ask for wearing an
     * edit's confirmation. Cancel is how an edit ends with nothing sent, and it is on screen the whole time. */
    if (intent === `place` || intent === `edit`) {
        return situation.staged;
    }
    return situation.staged || continueOffered(situation) || queueFlushable(situation);
};
