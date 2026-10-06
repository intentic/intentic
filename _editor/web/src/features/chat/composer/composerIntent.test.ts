// What the next Send press means, asserted as precedence: every state below can hold alongside the
// ones under it (a plan pending while a turn streams while an edit is armed), and these tests pin the
// order that resolves them.
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
    sendRefusalTitle,
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
    waitingOnYou: false,
    steerable: false,
    pickUp: undefined,
    queued: 0,
    connected: true,
    spentUntil: undefined,
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
    // The most specific act of the lot: pointing at a message wins over every standing posture below it.
    expect(sendIntentOf(chat({ streaming: true, pendingPlan: true, editing: true }))).toBe(`edit`);
    // The agent's voice is not a turn at all, so nothing about a turn can outrank it.
    expect(sendIntentOf(chat({ streaming: true, pendingPlan: true, editing: true, voiceAgent: true }))).toBe(`place`);
});

// The agents list says the agent waits on you before this window has drawn its card (a tab left open for hours): the
// composer reads as waiting on an answer, never idle, and a spent account does not turn that into a schedule.
it(`reads a chat the agents list says waits on you as parked, before its card is drawn`, () => {
    expect(sendIntentOf(chat({ waitingOnYou: true }))).toBe(`parked`);
    expect(sendIntentOf(chat({ waitingOnYou: true, spentUntil: 5_000 }))).toBe(`parked`);
    expect(placeholderFor(sendIntentOf(chat({ waitingOnYou: true })), WORDS)).toBe(`Answer above, or add a message for after…`);
    // A plan waiting is still the revision field, and an armed edit still an edit.
    expect(sendIntentOf(chat({ waitingOnYou: true, pendingPlan: true }))).toBe(`plan`);
    expect(sendIntentOf(chat({ waitingOnYou: true, editing: true }))).toBe(`edit`);
});

it(`schedules only a send that would start a turn on a spent account`, () => {
    const spent = { spentUntil: 5_000 };
    expect(sendIntentOf(chat(spent))).toBe(`scheduled`);
    expect(sendIntentOf(chat({ ...spent, staged: true }))).toBe(`scheduled`);
    // A live turn takes the words or queues them: the allowance is the running turn's business, not this press's.
    expect(sendIntentOf(chat({ ...spent, streaming: true }))).toBe(`queue`);
    expect(sendIntentOf(chat({ ...spent, streaming: true, steerable: true }))).toBe(`steer`);
    // A plan's revision and an armed edit still read as what they are.
    expect(sendIntentOf(chat({ ...spent, pendingPlan: true }))).toBe(`plan`);
    expect(sendIntentOf(chat({ ...spent, editing: true }))).toBe(`edit`);
    // Scheduling changes when, never whether: a staged message stays sendable.
    expect(sendable(chat({ ...spent, staged: true }), `scheduled`, undefined)).toBe(true);
    expect(sendable(chat(spent), `scheduled`, undefined)).toBe(false);
});

// The scheduled button reads as a time: an empty press there meaning "Continue now" did the opposite of its label, and
// on a spent account was refused before anything ran. Continue stays offered, to the strip's own button and to Enter.
it(`keeps a scheduled send's button shut on an empty box, even with a turn to continue`, () => {
    const held = chat({ spentUntil: 5_000, pickUp: { ready: true } });
    expect(continueOffered(held)).toBe(true);
    expect(sendable(held, `scheduled`, undefined)).toBe(false);
    expect(sendable(chat({ spentUntil: 5_000, queued: 1 }), `scheduled`, undefined)).toBe(false);
    // An account with room keeps the ordinary empty press as Continue.
    expect(sendable(chat({ pickUp: { ready: true } }), `idle`, undefined)).toBe(true);
});

it(`says when a scheduled send goes, and that a turn already waiting goes ahead of it`, () => {
    const words = { ...WORDS, reopens: `Sun 08:20` };
    expect(placeholderFor(`scheduled`, words)).toContain(`Sun 08:20`);
    expect(JSON.stringify(sendHintFor(`scheduled`, words))).toContain(`Sun 08:20`);
    expect(sendHintFor(`scheduled`, { ...words, followsWaiting: true })).not.toEqual(sendHintFor(`scheduled`, words));
});

// A time or an agent picked for the message is the reader choosing the moment: it books the send whatever the chat is
// doing, a running turn or a spent account included, and only acts that are not a send at all outrank it.
it(`books a message for the moment the reader picked, whatever the chat is doing`, () => {
    const later = { later: true };
    expect(sendIntentOf(chat(later))).toBe(`later`);
    expect(sendIntentOf(chat({ ...later, streaming: true, steerable: true }))).toBe(`later`);
    expect(sendIntentOf(chat({ ...later, streaming: true, awaitingDecision: true }))).toBe(`later`);
    expect(sendIntentOf(chat({ ...later, spentUntil: 5_000 }))).toBe(`later`);
    expect(sendIntentOf(chat({ ...later, waitingOnYou: true }))).toBe(`later`);
    // A plan's revision, an armed edit and the agent's voice are not sends to book.
    expect(sendIntentOf(chat({ ...later, pendingPlan: true }))).toBe(`plan`);
    expect(sendIntentOf(chat({ ...later, editing: true }))).toBe(`edit`);
    expect(sendIntentOf(chat({ ...later, voiceAgent: true }))).toBe(`place`);
    // Its button reads as a time, so an empty press does nothing rather than continue or flush the queue now.
    expect(sendable(chat({ ...later, staged: true }), `later`, undefined)).toBe(true);
    expect(sendable(chat({ ...later, pickUp: { ready: true } }), `later`, undefined)).toBe(false);
    expect(sendable(chat({ ...later, queued: 1 }), `later`, undefined)).toBe(false);
});

it(`says when a booked message goes, and that an ordinary send takes what is scheduled with it`, () => {
    expect(sendHintFor(`later`, { ...WORDS, later: `Tomorrow 09:00` })).toEqual({
        title: `Schedule`,
        rows: [{ label: `Sends`, value: `Tomorrow 09:00` }],
        note: `It waits in this chat, where you can send it sooner, change when, or take it back.`,
    });
    expect(placeholderFor(`later`, WORDS)).toBe(`Write the message to schedule…`);
    expect(sendHintFor(`idle`, WORDS)).toBe(`Send`);
    // Said only for a sandbox that books the whole queue, where an ordinary send lets a booking go too (composerSend.ts);
    // one that books each message keeps every booking on its time, and the plain hint stands.
    expect(sendHintFor(`idle`, { ...WORDS, heldGoesToo: true })).toEqual({ title: `Send`, note: `What is scheduled in this chat goes now too.` });
    expect(sendHintFor(`idle`, { ...WORDS, heldGoesToo: false })).toBe(`Send`);
});

it(`gives every intent its own sentence in both slots`, () => {
    const intents: readonly SendIntent[] = [`place`, `edit`, `plan`, `later`, `scheduled`, `idle`, `parked`, `steer`, `queue`];
    const placeholders = intents.map((intent) => placeholderFor(intent, WORDS));
    const hints = intents.map((intent) => JSON.stringify(sendHintFor(intent, WORDS)));

    // No intent can be added without words for it, and no two share a sentence.
    expect(new Set(placeholders).size).toBe(intents.length);
    expect(new Set(hints).size).toBe(intents.length);
});

it(`counts what an edit costs, and says it in the singular where only one message goes`, () => {
    expect(sendHintFor(`edit`, WORDS)).toBe(`Replace message`);
    expect(sendHintFor(`edit`, { ...WORDS, editDropped: 4 })).toEqual({ title: `Replace message`, rows: [{ label: `Also replaced`, value: 3 }] });
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
    // A rewind can't be spent while a turn holds the conversation; the edit stays armed and this names why.
    expect(sendRefusal(chat({ staged: true, editing: true, streaming: true }))).toContain(`once the turn ends`);
    expect(sendRefusal(chat({ staged: true, editing: true }))).toBeUndefined();
    // The greyed button names the same rule in a word or two; the sentence is the status line's.
    expect(sendRefusalTitle(chat({ staged: true, uploadFailed: true }))).toBe(`Upload failed`);
    expect(sendRefusalTitle(chat({ staged: true, editing: true }))).toBeUndefined();
});

it(`refuses more of the agent's voice than of your own`, () => {
    const speaking = { staged: true, voiceAgent: true };
    expect(sendRefusal(chat({ ...speaking, streaming: true }))).toContain(`turn ends`);
    expect(sendRefusal(chat({ ...speaking, pendingPlan: true }))).toContain(`plan`);
    expect(sendRefusal(chat({ ...speaking, attached: true }))).toContain(`agent`);
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

// Two readings of one stopped turn: before the instant a spent allowance's press starts working, the
// strip has something to say but the press has nothing to do.
it(`says what happened while the press is still waiting, without arming it`, () => {
    const waiting = chat({ pickUp: { ready: false } });
    expect(continueVisible(waiting)).toBe(true);
    expect(continueOffered(waiting)).toBe(false);
    // The bare press sends nothing while it waits: Enter falls back to what it always did.
    expect(sendable(waiting, sendIntentOf(waiting), sendRefusal(waiting))).toBe(false);

    // Everything that silences the offer silences the strip with it: the box is the user's answer now.
    expect(continueVisible({ ...waiting, staged: true })).toBe(false);
    expect(continueVisible({ ...waiting, queued: 1 })).toBe(false);
});

it(`sends the box, the queue or the continuation, but spends an edit or a placement on words only`, () => {
    const sends = (state: ComposerSituation): boolean => sendable(state, sendIntentOf(state), sendRefusal(state));

    expect(sends(SETTLED)).toBe(false);
    expect(sends(chat({ staged: true }))).toBe(true);
    // The bare presses that send something other than the draft.
    expect(sends(chat({ pickUp: { ready: true } }))).toBe(true);
    expect(sends(chat({ queued: 2 }))).toBe(true);
    // Neither may spend an armed edit or the agent's voice, which would drop turns silently or place a
    // blank line.
    expect(sends(chat({ pickUp: { ready: true }, editing: true }))).toBe(false);
    expect(sends(chat({ queued: 2, voiceAgent: true }))).toBe(false);
    // A refusal outranks all of it.
    expect(sends(chat({ staged: true, uploading: true }))).toBe(false);
});
