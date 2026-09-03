import type { TranscriptRow } from "@intentic/sandbox-contract";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TranscriptClock } from "./transcriptClock";
import type { AttachEntry, AttachHead } from "./turnStream";

/* WHO THE TYPEWRITER IS FOR: the pane the reader is in, and nobody else.
 *
 * A floating chat window shows as many chats side by side as the user picks (ChatPanel's panes), and each
 * one that is streaming owns a clock. Left to themselves they would all type at once: N things moving in the
 * periphery of someone trying to read one of them, each paying the reveal's per-paint cost (a list rebuild to
 * append a few characters). So a transcript nobody is watching settles its text in the frame it arrives.
 *
 * Driven a FRAME AT A TIME here, because that is the whole difference: the buffer drains either way, and a
 * test that runs frames until the clock stops cannot tell "typed over ten frames" from "settled in one". */

const TURN = { userMessageId: 1, run: `run-1`, provider: `claude`, account: undefined, harness: `native` } as const;
const head = (rows: readonly TranscriptRow[], run = `run-1`): AttachHead => ({ kind: `attached`, run, startedAt: 0, seq: 0, rows: [...rows] });
const text = (index: number, words: string): AttachEntry => ({ kind: `patch`, seq: 1, patch: { op: `text`, index, text: words } });
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

// A run whose head holds the prompt and an open bubble, the shape every live turn has once its first word lands.
const attached = (clock: TranscriptClock): void => {
    clock.attachRun(
        head([
            { role: `user`, text: `hi` },
            { role: `assistant`, text: `` },
        ]),
    );
};

it(`types a watched transcript a slice at a time`, () => {
    const clock = new TranscriptClock(() => {});
    attached(clock);
    clock.push(text(1, ANSWER), TURN);

    paint();

    expect(said(clock)).not.toBe(``);
    expect(said(clock).length).toBeLessThan(ANSWER.length);
});

it(`settles an unwatched transcript in the frame its text arrives`, () => {
    const clock = new TranscriptClock(() => {});
    attached(clock);
    clock.watched.value = false;
    clock.push(text(1, ANSWER), TURN);

    paint();

    expect(said(clock)).toBe(ANSWER);
});

// The pane the user moves to takes over mid-answer: what is already buffered starts typing from there, rather
// than the transcript staying settled for the rest of the turn because of where the focus used to be.
it(`starts typing when a pane takes the focus mid-answer`, () => {
    const clock = new TranscriptClock(() => {});
    attached(clock);
    clock.watched.value = false;
    clock.push(text(1, ANSWER), TURN);
    paint();

    clock.watched.value = true;
    clock.push(text(1, ANSWER), TURN);
    paint();

    expect(said(clock).length).toBeGreaterThan(ANSWER.length);
    expect(said(clock).length).toBeLessThan(ANSWER.length * 2);
});

/* THE HEAD'S ROWS LAND WHOLE, however closely the pane is watched: they are history, nobody watched them
 * happen, and there is no pace to keep. Opening an agent that had been working for an hour used to mean
 * watching an hour of prose type itself out before reaching what the agent is doing NOW. */
it(`takes a head's rows whole, and types only what follows it`, () => {
    const clock = new TranscriptClock(() => {});
    clock.attachRun(
        head([
            { role: `user`, text: `hi` },
            { role: `assistant`, text: ANSWER },
        ]),
    );
    expect(said(clock)).toBe(ANSWER);

    clock.push(text(1, ANSWER), TURN);
    paint();

    expect(said(clock).length).toBeGreaterThan(ANSWER.length);
    expect(said(clock).length).toBeLessThan(ANSWER.length * 2);
});

/* RE-ATTACHING TO THE SAME RUN REPLACES ITS ROWS, never draws them again under themselves: the head carries the
 * run's transcript whole, and where this window last put the run is where the new copy goes. What the run sits
 * UNDER (the rows of earlier turns, a notice this window wrote) is untouched, and the bubble a send drew ahead
 * of the head is where the run's rows start: it keeps its id when the daemon's row replaces it. */
it(`replaces a run's rows on every head and keeps what sits above them`, () => {
    const clock = new TranscriptClock(() => {});
    clock.append({ role: `assistant`, text: `earlier answer` });
    const asked = clock.append({ role: `user`, text: `hi` });
    clock.attachRun(
        head([
            { role: `user`, text: `hi` },
            { role: `assistant`, text: `first` },
        ]),
        asked,
    );
    expect(clock.messages.value.map((message) => message.text)).toEqual([`earlier answer`, `hi`, `first`]);
    expect(clock.messages.value[1]?.id).toBe(asked);

    clock.attachRun(
        head([
            { role: `user`, text: `hi` },
            { role: `assistant`, text: `first and more` },
            { role: `notice`, text: `Stopped.` },
        ]),
    );
    expect(clock.messages.value.map((message) => message.text)).toEqual([`earlier answer`, `hi`, `first and more`, `Stopped.`]);
    expect(clock.messages.value[1]?.id).toBe(asked);

    // A different run is a new turn: it goes below everything this window holds.
    clock.attachRun(
        head(
            [
                { role: `notice`, text: `The sandbox came back.` },
                { role: `assistant`, text: `carrying on` },
            ],
            `run-2`,
        ),
    );
    expect(clock.messages.value.map((message) => message.text)).toEqual([
        `earlier answer`,
        `hi`,
        `first and more`,
        `Stopped.`,
        `The sandbox came back.`,
        `carrying on`,
    ]);
});

// A row the daemon replaces whole already holds every word this window was still revealing for it, so the
// buffer for that row is dropped rather than typed on top of text that already contains it.
it(`drops the typewriter's buffer for a row the daemon replaced whole`, () => {
    const clock = new TranscriptClock(() => {});
    attached(clock);
    clock.push(text(1, ANSWER), TURN);
    paint();
    clock.push({ kind: `patch`, seq: 2, patch: { op: `replace`, index: 1, row: { role: `assistant`, text: ANSWER, todos: [] } } }, TURN);
    paint();
    paint();

    expect(said(clock)).toBe(ANSWER);
});

// Every entry reaches the conversation once, in arrival order, with the replay flag it came with.
it(`hands every entry to the conversation in order`, () => {
    const seen: [string, boolean][] = [];
    const clock = new TranscriptClock((entry, _turn, replay) => seen.push([entry.kind === `patch` ? entry.patch.op : entry.fact.kind, replay]));
    attached(clock);
    clock.push({ kind: `fact`, seq: 1, fact: { kind: `session`, sessionId: `s1` } }, TURN, true);
    clock.push(text(1, `a`), TURN);
    paint();
    expect(seen).toEqual([
        [`session`, true],
        [`text`, false],
    ]);
});

// A notice this window writes is its own, marked so a fork counts it out, and stamped nothing else.
it(`marks its own notices local`, () => {
    const clock = new TranscriptClock(() => {});
    clock.notice(`Switched to Codex.`);
    expect(clock.messages.value).toEqual([{ id: 1, role: `notice`, text: `Switched to Codex.`, local: true }]);
});
