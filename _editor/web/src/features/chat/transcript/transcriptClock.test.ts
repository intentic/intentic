import type { TranscriptRow } from "@intentic/sandbox-contract";
import { it, expect, beforeEach, afterEach, jest } from "bun:test";
import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { TranscriptClock } from "./transcriptClock";
import type { AttachEntry, AttachHead } from "../run/turnStream";

// Needs fake timers/rAF (paint() drives frames by hand) to tell "typed over N frames" apart from "settled in one". Only
// the watched pane types; unwatched panes settle whole in the frame text arrives.

const TURN = { userMessageId: 1, run: `run-1`, provider: `claude`, account: undefined, harness: `native` } as const;
// Rows come stamped with their run, as TurnRun stamps everything it emits (turn-runs.ts): that mark is how an attach
// finds the rows it is already showing.
const head = (rows: readonly TranscriptRow[], run = `run-1`): AttachHead => ({
    kind: `attached`,
    run,
    startedAt: 0,
    seq: 0,
    rows: rows.map((row) => ({ ...row, run })),
});
const text = (index: number, words: string): AttachEntry => ({ kind: `patch`, seq: 1, patch: { op: `text`, index, text: words } });
// Long enough that one slice of it cannot be the whole thing (revealPending takes an eighth, floor 2 chars).
const ANSWER = `an answer long enough that a single slice of it is nowhere near the whole thing`;

let frames: FrameRequestCallback[] = [];

beforeEach(() => {
    // The clock also arms a fallback timer per tick; faking timers keeps one from firing into a finished test.
    jest.useFakeTimers();
    frames = [];
    stubGlobal(`requestAnimationFrame`, (callback: FrameRequestCallback): number => frames.push(callback));
});

afterEach(() => {
    unstubAllGlobals();
    jest.useRealTimers();
});

// One paint only: frames scheduled during the tick wait for the next call to this.
const paint = (): void => {
    for (const frame of frames.splice(0, frames.length)) {
        frame(0);
    }
};

const said = (clock: TranscriptClock): string => clock.messages.value.at(-1)?.text ?? ``;

// A run whose head holds the prompt and an open bubble, the shape of a live turn once its first word lands.
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

// Re-attaching the same run replaces its rows in place, keeping what sits above untouched; the bubble a send drew ahead
// of the head keeps its id when the daemon's row replaces it.
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

/* THE SAME RUN, IN A WINDOW THAT NEVER DREW IT: a redraw from the daemon's record, then an attach to the run that
   wrote those very rows, which is what a settled run still inside its retention window hands back. */
it(`reclaims the rows it is already showing when it holds no base for the run`, () => {
    const clock = new TranscriptClock(() => {});
    clock.rebuild([
        { role: `user`, text: `fix it`, sentAt: 1_000, run: `run-1` },
        { role: `assistant`, text: `Tracing.`, run: `run-1` },
    ]);
    const drawnAnswer = clock.messages.value[1]?.id;

    clock.attachRun(
        head([
            { role: `user`, text: `fix it`, sentAt: 1_000 },
            { role: `assistant`, text: `Tracing.` },
            { role: `assistant`, text: `Found it.` },
        ]),
    );

    expect(clock.messages.value.map((message) => message.text)).toEqual([`fix it`, `Tracing.`, `Found it.`]);
    // RECLAIMED, not redrawn: the rows keep the ids they were already carrying, so a card answered by id is
    // still answering the same row, and a view keyed on it repaints rather than remounting.
    expect(clock.messages.value[1]?.id).toBe(drawnAnswer);
});

/* THE SAME RUN, STILL GROWING: WHAT A RELOAD MID-TURN ACTUALLY HANDS THE NEXT ATTACH. */
it(`reclaims a run whose last drawn row has grown since the mirror was written`, () => {
    const clock = new TranscriptClock(() => {});
    // The mirror paintCached restores: the run as it stood when this window last wrote it to disk.
    clock.adopt([
        { id: 1, role: `user`, text: `fix it`, sentAt: 1_000, run: `run-1` },
        { id: 2, role: `assistant`, text: `Tracing.`, run: `run-1` },
    ]);

    // The same run, attached again after the reload; its last row has kept typing since.
    clock.attachRun(
        head([
            { role: `user`, text: `fix it`, sentAt: 1_000 },
            { role: `assistant`, text: `Tracing. Found it.` },
        ]),
    );

    expect(clock.messages.value.map((message) => message.text)).toEqual([`fix it`, `Tracing. Found it.`]);
    expect(clock.messages.value.map((message) => message.id)).toEqual([1, 2]);
});

// Each reattach writes the mirror the next one paints from, so an alignment that misses compounds: the prompt
// comes back once per reload rather than standing where it was.
it(`reclaims the same run however many times it is reattached`, () => {
    const clock = new TranscriptClock(() => {});
    for (const answer of [`Tracing.`, `Tracing. Found it.`, `Tracing. Found it. Fixed.`]) {
        // Each pass is a reload: the mirror is painted back, then the live run is attached again.
        clock.adopt(clock.messages.value);
        clock.attachRun(
            head([
                { role: `user`, text: `fix it`, sentAt: 1_000 },
                { role: `assistant`, text: answer },
            ]),
        );
    }

    expect(clock.messages.value.map((message) => message.text)).toEqual([`fix it`, `Tracing. Found it. Fixed.`]);
});

// A mirror written while the run was being drawn twice is still on disk for anyone the bug reached. The head is the
// authority on everything from where its run starts, so the extra copies go without the reader clearing storage.
it(`repairs a mirror that already holds the run more than once`, () => {
    const clock = new TranscriptClock(() => {});
    clock.adopt([
        { id: 1, role: `user`, text: `fix it`, sentAt: 1_000, run: `run-1` },
        { id: 2, role: `assistant`, text: `Tracing.`, run: `run-1` },
        { id: 3, role: `user`, text: `fix it`, sentAt: 1_000, run: `run-1` },
        { id: 4, role: `assistant`, text: `Tracing. Found it.`, run: `run-1` },
    ]);

    clock.attachRun(
        head([
            { role: `user`, text: `fix it`, sentAt: 1_000 },
            { role: `assistant`, text: `Tracing. Found it.` },
        ]),
    );

    expect(clock.messages.value.map((message) => message.text)).toEqual([`fix it`, `Tracing. Found it.`]);
});

// And it takes only the tail that matches: what sits above is earlier turns and this window's own lines, which
// no head has any claim on.
it(`reclaims only as far back as the head's rows reach`, () => {
    const clock = new TranscriptClock(() => {});
    // An earlier turn, this window's own line between the two, and the live run's rows: the mirror as a reload finds it.
    clock.adopt([
        { id: 1, role: `assistant`, text: `earlier answer`, run: `run-0` },
        { id: 2, role: `notice`, text: `Switched to opus.`, local: true },
        { id: 3, role: `user`, text: `fix it`, sentAt: 1_000, run: `run-1` },
        { id: 4, role: `assistant`, text: `Tracing.`, run: `run-1` },
    ]);

    clock.attachRun(
        head([
            { role: `user`, text: `fix it`, sentAt: 1_000 },
            { role: `assistant`, text: `Tracing.` },
        ]),
    );

    expect(clock.messages.value.map((message) => message.text)).toEqual([`earlier answer`, `Switched to opus.`, `fix it`, `Tracing.`]);
});

// Paging older history mid-turn moves every row down, the live run's among them. A patch names its row by position
// within the run, so that cursor has to move too, or the next words land in a bubble from an earlier turn.
it(`keeps a live run's patches on target after an older page is prepended`, () => {
    const clock = new TranscriptClock(() => {});
    attached(clock);
    clock.prepend([
        { role: `user`, text: `an earlier question` },
        { role: `assistant`, text: `an earlier answer` },
    ]);

    clock.watched.value = false;
    clock.push(text(1, ANSWER), TURN);
    paint();

    expect(clock.messages.value.map((message) => message.text)).toEqual([`an earlier question`, `an earlier answer`, `hi`, ANSWER]);
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

it(`marks its own notices local`, () => {
    const clock = new TranscriptClock(() => {});
    clock.notice(`Switched to Codex.`);
    expect(clock.messages.value).toEqual([{ id: 1, role: `notice`, text: `Switched to Codex.`, local: true }]);
});
