import { type AgentEvent, RESUME_NOTES, withoutResumeNote, withResumeNote } from "@intentic/sandbox-contract";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TranscriptClock } from "./transcriptClock";

/* WHO THE TYPEWRITER IS FOR: the pane the reader is in, and nobody else.
 *
 * A floating chat window shows as many chats side by side as the user picks (ChatPanel's panes), and each
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

/* A REPLAY IS NOT AN ANSWER BEING WRITTEN, and the typewriter is only for the latter.
 *
 * Attaching to a live run replays it from the client's cursor before going live, and the head names the seq
 * that boundary sits at. That boundary was published and then dropped on the floor here: every replayed frame
 * went through the reveal, so opening an agent that had been working for an hour meant watching an hour of
 * prose type itself out before reaching what the agent is doing NOW. It is history: it is put on screen whole,
 * exactly as an unwatched transcript's is, and for a stricter version of the same reason (nobody watched it
 * happen, so there is no pace to keep). */
it(`settles replayed text whole, however closely the pane is being watched`, () => {
    const clock = new TranscriptClock(() => {});
    clock.push(delta(ANSWER), TURN, true);

    paint();

    expect(said(clock)).toBe(ANSWER);
});

/* …AND STARTS TYPING AGAIN AT THE BOUNDARY, in the same paint if that is where it falls. One attach routinely
 * straddles it: the tail of the replay and the model's next word arrive together, and the reader should get
 * the caught-up transcript at once and then watch it carry on being written. */
it(`types again from the first live frame after a replay`, () => {
    const clock = new TranscriptClock(() => {});
    clock.push(delta(ANSWER), TURN, true);
    paint();

    clock.push(delta(ANSWER), TURN, false);
    paint();

    expect(said(clock).length).toBeGreaterThan(ANSWER.length);
    expect(said(clock).length).toBeLessThan(ANSWER.length * 2);
});

/* THE RUN A ROW BELONGS TO, LEARNED A BEAT LATE, which is the send path's whole relationship with run ids: it
 * opens the bubble the typing indicator needs before the daemon has named anything, and the ack names the run
 * afterwards. Unstamped, that bubble was invisible to dropRun, so re-attaching could not take it back AND could
 * not reach past it to the stamped rows above, which is how one prompt came to be drawn twice with an empty
 * "thinking" bubble wedged between the copies. */
it(`stamps the bubble a send opened once the ack names its run, so a re-attach can take it back`, () => {
    const clock = new TranscriptClock(() => {});
    clock.append({ role: `user`, text: `ship the parser` });
    const bubble = clock.openBubble();

    clock.dropRun(TURN.run);
    expect(clock.messages.value).toHaveLength(2); // unstamped: the drop cannot see it

    clock.claimRun(bubble, TURN.run);
    clock.dropRun(TURN.run);

    expect(clock.messages.value.map((message) => message.role)).toEqual([`user`]);
});

// The user's own row is deliberately NOT stamped: a replay never redraws it (reuseUserBubble keeps it, with the
// attachment chips and checkpoint no replay can rebuild), so a stamp there would invite dropRun to take away
// the one row nothing puts back.
it(`leaves the user's own bubble unstamped, where no replay will redraw it`, () => {
    const clock = new TranscriptClock(() => {});
    const asked = clock.append({ role: `user`, text: `ship the parser` });
    clock.claimRun(clock.openBubble(), TURN.run);

    clock.dropRun(TURN.run);

    expect(clock.reuseUserBubble(`ship the parser`, true)).toBe(asked);
});
