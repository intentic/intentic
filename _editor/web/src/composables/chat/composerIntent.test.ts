/* WHAT THE NEXT PRESS OF SEND MEANS, asserted as a table, because the four surfaces that answer that question
 * used to answer it four times over, and the bug they produced is the one shape a unit test can pin: two of them
 * disagreeing about the same chat.
 *
 * So the assertions here are mostly about PRECEDENCE. Every state below can hold at the same time as the ones
 * under it: a plan can be pending while a turn streams while an edit is armed, and each of those pairs was
 * reachable in the app before this was one decision. */
import { expect, it } from "vitest";
import {
    type ComposerSituation,
    type ComposerWords,
    continueOffered,
    continueVisible,
    placeholderFor,
    sendable,
    sendHintFor,
    type SendIntent,
    sendIntentOf,
    sendRefusal,
} from "./composerIntent";

// A settled chat with an account, an empty box and nothing armed: every test states the part it is about.
const SETTLED: ComposerSituation = {
    staged: false,
    attached: false,
    uploading: false,
    uploadFailed: false,
    voiceAgent: false,
    editing: false,
    pendingPlan: false,
    streaming: false,
    awaitingDecision: false,
    steerable: false,
    pickUp: undefined,
    queued: 0,
    connected: true,
};
const chat = (state: Partial<ComposerSituation>): ComposerSituation => ({ ...SETTLED, ...state });

const WORDS: ComposerWords = { provider: `Claude`, onTrial: false, editDropped: 1 };

it(`names the press by the most specific thing armed, in one order`, () => {
    expect(sendIntentOf(SETTLED)).toBe(`idle`);
    expect(sendIntentOf(chat({ streaming: true }))).toBe(`queue`);
    expect(sendIntentOf(chat({ streaming: true, steerable: true }))).toBe(`steer`);
    // A card outranks steering: those messages are only sitting in the queue because the turn is parked.
    expect(sendIntentOf(chat({ streaming: true, steerable: true, awaitingDecision: true }))).toBe(`parked`);
    // A plan awaiting an answer turns the composer into the revision field, whatever the turn is doing.
    expect(sendIntentOf(chat({ streaming: true, pendingPlan: true }))).toBe(`plan`);
    // The user pointed at one message in this transcript: the most specific act of the lot, so it wins over
    // every standing posture below it.
    expect(sendIntentOf(chat({ streaming: true, pendingPlan: true, editing: true }))).toBe(`edit`);
    // …and the agent's voice is not a turn at all, so nothing about a turn can outrank it.
    expect(sendIntentOf(chat({ streaming: true, pendingPlan: true, editing: true, voiceAgent: true }))).toBe(`place`);
});

it(`gives every intent its own sentence in both slots`, () => {
    const intents: readonly SendIntent[] = [`place`, `edit`, `plan`, `idle`, `parked`, `steer`, `queue`];
    const placeholders = intents.map((intent) => placeholderFor(intent, WORDS));
    const hints = intents.map((intent) => sendHintFor(intent, WORDS));

    // The point of the tables: no intent can be added without words for it, and no two share a sentence, the
    // reader learns what the press does from either slot, and they cannot contradict each other.
    expect(new Set(placeholders).size).toBe(intents.length);
    expect(new Set(hints).size).toBe(intents.length);
});

it(`counts what an edit costs, and says it in the singular where only one message goes`, () => {
    expect(sendHintFor(`edit`, WORDS)).toBe(`Replace this message`);
    expect(sendHintFor(`edit`, { ...WORDS, editDropped: 4 })).toBe(`Replace this message and the 3 below it`);
});

it(`asks nobody by name on the trial: the product's own channel has no vendor`, () => {
    expect(placeholderFor(`idle`, WORDS)).toBe(`Ask Claude…`);
    expect(placeholderFor(`idle`, { ...WORDS, onTrial: true })).toBe(`Ask anything…`);
});

it(`refuses only what the daemon would, and only with something staged`, () => {
    // An empty composer explains itself; a refusal there would be a warning about nothing.
    expect(sendRefusal(chat({ uploadFailed: true }))).toBeUndefined();

    expect(sendRefusal(chat({ staged: true, uploading: true }))).toContain(`uploading`);
    expect(sendRefusal(chat({ staged: true, uploadFailed: true }))).toContain(`failed to upload`);
    // A rewind cannot be spent while a turn holds the conversation. The edit stays armed: this is the sentence
    // that says so, in place of a Send greying itself out with no cause on screen anywhere.
    expect(sendRefusal(chat({ staged: true, editing: true, streaming: true }))).toContain(`once the turn ends`);
    expect(sendRefusal(chat({ staged: true, editing: true }))).toBeUndefined();
});

it(`refuses more of the agent's voice than of your own`, () => {
    const speaking = { staged: true, voiceAgent: true };
    expect(sendRefusal(chat({ ...speaking, streaming: true }))).toContain(`its words can be placed once the turn ends`);
    expect(sendRefusal(chat({ ...speaking, pendingPlan: true }))).toContain(`decide it before speaking as the agent`);
    // There is no shape of transcript in which the agent attached a file to its own reply.
    expect(sendRefusal(chat({ ...speaking, attached: true }))).toContain(`can't be placed as the agent's words`);
    // The same three states refuse nothing when the words are the user's own: they are sent, steered or queued.
    expect(sendRefusal(chat({ staged: true, streaming: true }))).toBeUndefined();
    expect(sendRefusal(chat({ staged: true, pendingPlan: true, attached: true }))).toBeUndefined();
});

it(`offers to continue a stopped turn only when the press could mean nothing else`, () => {
    const stopped = chat({ pickUp: { ready: true } });
    expect(continueOffered(stopped)).toBe(true);

    // Words or files in the box are what the user means to send.
    expect(continueOffered({ ...stopped, staged: true })).toBe(false);
    // A queued message is already the answer to "what happens next".
    expect(continueOffered({ ...stopped, queued: 1 })).toBe(false);
    // A plan turns the box into the revision field, where a continuation would be feedback instead.
    expect(continueOffered({ ...stopped, pendingPlan: true })).toBe(false);
    // Nothing to continue with.
    expect(continueOffered({ ...stopped, connected: false })).toBe(false);
});

/* THE TWO READINGS OF ONE STOPPED TURN, and the whole reason there are two. A spent allowance stops the turn
 * and names the instant its own press starts working: before that instant the strip has plenty to say and the
 * press has nothing to do, so the sentence is visible and the key is not. The old code had one predicate, which
 * forced that ending to choose between an offer that re-fails and no offer at all, and it chose neither. */
it(`says what happened while the press is still waiting, without arming it`, () => {
    const waiting = chat({ pickUp: { ready: false } });
    expect(continueVisible(waiting)).toBe(true);
    expect(continueOffered(waiting)).toBe(false);
    // ...and the bare press sends nothing while it waits: Enter falls back to what it always did.
    expect(sendable(waiting, sendIntentOf(waiting), sendRefusal(waiting))).toBe(false);

    // Everything that silences the offer silences the strip with it: the box is the user's answer now.
    expect(continueVisible({ ...waiting, staged: true })).toBe(false);
    expect(continueVisible({ ...waiting, queued: 1 })).toBe(false);
});

it(`sends the box, the queue or the continuation, but spends an edit or a placement on words only`, () => {
    const sends = (state: ComposerSituation): boolean => sendable(state, sendIntentOf(state), sendRefusal(state));

    expect(sends(SETTLED)).toBe(false);
    expect(sends(chat({ staged: true }))).toBe(true);
    // The bare presses that send something OTHER than the draft.
    expect(sends(chat({ pickUp: { ready: true } }))).toBe(true);
    expect(sends(chat({ queued: 2 }))).toBe(true);
    // …and neither of them may spend an armed edit or the agent's voice: an empty box would drop the turns and
    // then ask nothing, or place a blank line into the transcript.
    expect(sends(chat({ pickUp: { ready: true }, editing: true }))).toBe(false);
    expect(sends(chat({ queued: 2, voiceAgent: true }))).toBe(false);
    // A refusal outranks all of it.
    expect(sends(chat({ staged: true, uploading: true }))).toBe(false);
});
