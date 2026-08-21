import { type AgentEvent, RESUME_NOTES, withoutResumeNote, withResumeNote } from "@intentic/sandbox-contract";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TranscriptClock } from "./transcriptClock";

/* WHO THE TYPEWRITER IS FOR: the pane the reader is in, and nobody else.
 *
 * A popped-out chat window shows as many chats side by side as the user picks (ChatPanel's panes), and each
 * one that is streaming owns a clock. Left to themselves they would all type at once: N things moving in the
 * periphery of someone trying to read one of them, each paying the reveal's per-paint cost (a reducer pass to
 * append a few characters). So a transcript nobody is watching settles its text in the frame it arrives.
 *
 * Driven a FRAME AT A TIME here, because that is the whole difference: the buffer drains either way, and a
 * test that runs frames until the clock stops cannot tell "typed over ten frames" from "settled in one". */

const TURN = { userMessageId: 1, run: `run-1`, provider: `claude`, account: undefined, harness: `native` } as const;
const delta = (text: string): AgentEvent => ({ kind: `delta`, text }) as AgentEvent;
// Long enough that one slice of it cannot be the whole thing (revealPending takes an eighth, floor 2 chars).
const ANSWER = `an answer long enough that a single slice of it is nowhere near the whole thing`;

let frames: FrameRequestCallback[] = [];

beforeEach(() => {
    // The clock also arms a fallback timer per tick; faking timers keeps one from firing into a finished test.
    vi.useFakeTimers();
    frames = [];
    vi.stubGlobal(`requestAnimationFrame`, (callback: FrameRequestCallback): number => frames.push(callback));
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

// Exactly one paint of whatever the clock has asked for: the frames it schedules DURING the tick wait for the
// next call, which is what makes "one frame" a measurable thing.
const paint = (): void => {
    for (const frame of frames.splice(0, frames.length)) {
        frame(0);
    }
};

const said = (clock: TranscriptClock): string => clock.messages.value.at(-1)?.text ?? ``;

it(`types a watched transcript a slice at a time`, () => {
    const clock = new TranscriptClock(() => {});
    clock.push(delta(ANSWER), TURN);

    paint();

    expect(said(clock)).not.toBe(``);
    expect(said(clock).length).toBeLessThan(ANSWER.length);
});

it(`settles an unwatched transcript in the frame its text arrives`, () => {
    const clock = new TranscriptClock(() => {});
    clock.watched.value = false;
    clock.push(delta(ANSWER), TURN);

    paint();

    expect(said(clock)).toBe(ANSWER);
});

/* THE ATTACH HEAD OF A RESUMED TURN, folded the way Conversation.reattach folds it: the prompt through
 * withoutResumeNote, then reuseUserBubble against what the transcript already shows. The two resume shapes
 * want OPPOSITE outcomes and this is the seam that decides them. A re-run repeats the original request behind
 * its note, so the stripped words match the bubble the user really typed and that bubble is reused; an
 * `answered` resume carries the user's ANSWER to a restored card: words the transcript has never shown, so
 * it must land as its own bubble rather than be mistaken for the question it answers. */
it(`a re-run's head reuses the prompt's own bubble; an answered park's head lands as its own`, () => {
    const clock = new TranscriptClock(() => {});
    const asked = clock.append({ role: `user`, text: `ship the parser` });

    const rerun = withoutResumeNote(withResumeNote(`ship the parser`, RESUME_NOTES.restart));
    expect(clock.reuseUserBubble(rerun, false)).toBe(asked);

    const answered = withoutResumeNote(withResumeNote(`The user approved the plan: proceed with it.`, RESUME_NOTES.answered));
    // The strip leaves exactly the answer: no machine preamble in a user bubble either way.
    expect(answered).toBe(`The user approved the plan: proceed with it.`);
    expect(clock.reuseUserBubble(answered, false)).toBeUndefined();
});

// The pane the user moves to takes over mid-answer: what is already buffered starts typing from there, rather
// than the transcript staying settled for the rest of the turn because of where the focus used to be.
it(`starts typing when a pane takes the focus mid-answer`, () => {
    const clock = new TranscriptClock(() => {});
    clock.watched.value = false;
    clock.push(delta(ANSWER), TURN);
    paint();

    clock.watched.value = true;
    clock.push(delta(ANSWER), TURN);
    paint();

    expect(said(clock).length).toBeGreaterThan(ANSWER.length);
    expect(said(clock).length).toBeLessThan(ANSWER.length * 2);
});
