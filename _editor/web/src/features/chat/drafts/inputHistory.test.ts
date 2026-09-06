// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { InputHistory, inputHistoryFor, onFirstLine, onLastLine, recallStep } from "./inputHistory";

const fresh = (key = `test`): InputHistory => new InputHistory(key);

beforeEach(() => {
    localStorage.clear();
});

describe(`onFirstLine / onLastLine`, () => {
    it(`treat a single-line draft as both`, () => {
        expect(onFirstLine(`run tests`, 9)).toBe(true);
        expect(onLastLine(`run tests`, 9)).toBe(true);
        expect(onFirstLine(``, 0)).toBe(true);
        expect(onLastLine(``, 0)).toBe(true);
    });

    it(`split a multi-line draft so the arrows move the caret in the middle`, () => {
        const text = `first\nsecond\nthird`;
        expect([onFirstLine(text, 3), onLastLine(text, 3)]).toEqual([true, false]);
        expect([onFirstLine(text, 8), onLastLine(text, 8)]).toEqual([false, false]);
        expect([onFirstLine(text, 15), onLastLine(text, 15)]).toEqual([false, true]);
    });
});

describe(`InputHistory`, () => {
    it(`cycles back through sent messages, newest first`, () => {
        const history = fresh();
        history.record(`one`);
        history.record(`two`);

        expect(history.recalling).toBe(false);
        expect(history.previous(``)).toBe(`two`);
        expect(history.previous(``)).toBe(`one`);
        expect(history.recalling).toBe(true);
        // Already at the oldest: undefined leaves the key to the browser rather than re-pasting `one`.
        expect(history.previous(``)).toBeUndefined();
    });

    it(`restores the displaced draft on the way forward and on Escape`, () => {
        const history = fresh();
        history.record(`one`);
        history.record(`two`);

        expect(history.previous(`half-typed`)).toBe(`two`);
        expect(history.previous(`half-typed`)).toBe(`one`);
        expect(history.next()).toBe(`two`);
        expect(history.next()).toBe(`half-typed`);
        expect(history.recalling).toBe(false);

        expect(history.previous(`other draft`)).toBe(`two`);
        expect(history.cancel()).toBe(`other draft`);
        expect(history.recalling).toBe(false);
    });

    it(`no-ops the forward keys when not recalling`, () => {
        const history = fresh();
        history.record(`one`);
        expect(history.next()).toBeUndefined();
        expect(history.cancel()).toBeUndefined();
    });

    it(`recalls nothing from an empty ring`, () => {
        expect(fresh().previous(`draft`)).toBeUndefined();
    });

    it(`trims, skips blanks, and collapses consecutive duplicates`, () => {
        const history = fresh();
        history.record(`  one  `);
        history.record(`   `);
        history.record(`one`);
        history.record(`two`);
        history.record(`one`);

        expect(history.previous(``)).toBe(`one`);
        expect(history.previous(``)).toBe(`two`);
        expect(history.previous(``)).toBe(`one`);
        expect(history.previous(``)).toBeUndefined();
    });

    it(`ends recall when a message is sent, so the stale stash cannot come back`, () => {
        const history = fresh();
        history.record(`one`);
        history.previous(`draft`);
        history.record(`two`);

        expect(history.recalling).toBe(false);
        expect(history.next()).toBeUndefined();
        expect(history.previous(``)).toBe(`two`);
    });

    it(`caps the ring at 100, dropping the oldest`, () => {
        const history = fresh();
        for (let i = 0; i < 105; i += 1) {
            history.record(`m${i}`);
        }
        for (let i = 0; i < 100; i += 1) {
            expect(history.previous(``)).toBe(`m${104 - i}`);
        }
        expect(history.previous(``)).toBeUndefined();
    });

    it(`persists to localStorage and reloads from it`, () => {
        const history = fresh(`intentic.inputHistory.sbx`);
        history.record(`one`);
        history.record(`two`);

        expect(new InputHistory(`intentic.inputHistory.sbx`).previous(``)).toBe(`two`);
    });

    it(`degrades to an empty ring on malformed storage`, () => {
        localStorage.setItem(`broken`, `{not json`);
        expect(fresh(`broken`).previous(``)).toBeUndefined();
        localStorage.setItem(`wrong-shape`, `{"entries":["one"]}`);
        expect(fresh(`wrong-shape`).previous(``)).toBeUndefined();
    });
});

describe(`recallStep`, () => {
    // Long enough to wrap over several rows in the composer while still being ONE line of text: the draft the
    // caret step exists for.
    const wrapped = `please review the diff and tell me whether the caching layer still makes sense`;
    const stocked = (): InputHistory => {
        const history = fresh();
        history.record(`one`);
        history.record(`two`);
        return history;
    };

    it(`recalls straight away from an empty composer`, () => {
        expect(recallStep(stocked(), `ArrowUp`, ``, 0)).toEqual({ kind: `text`, text: `two` });
    });

    it(`parks the caret at the start before recalling, so ↑ inside a wrapped draft moves instead of pasting`, () => {
        const history = stocked();

        expect(recallStep(history, `ArrowUp`, wrapped, 40)).toEqual({ kind: `caret`, at: 0 });
        // The ring stayed where it was: nothing was recalled, so nothing was stashed either.
        expect(history.recalling).toBe(false);
        expect(recallStep(history, `ArrowUp`, wrapped, 0)).toEqual({ kind: `text`, text: `two` });
    });

    it(`keeps ↑ cycling from the caret recall itself parked at the end of the message`, () => {
        const history = stocked();

        expect(recallStep(history, `ArrowUp`, ``, 0)).toEqual({ kind: `text`, text: `two` });
        expect(recallStep(history, `ArrowUp`, `two`, 3)).toEqual({ kind: `text`, text: `one` });
    });

    it(`steps the caret inside a recalled message once the user has moved it, without losing the ring's place`, () => {
        const history = stocked();
        recallStep(history, `ArrowUp`, ``, 0);

        expect(recallStep(history, `ArrowUp`, `two`, 2)).toEqual({ kind: `caret`, at: 0 });
        expect(recallStep(history, `ArrowUp`, `two`, 0)).toEqual({ kind: `text`, text: `one` });
    });

    it(`leaves the arrows to the browser in the middle of a multi-line draft`, () => {
        const history = stocked();
        const draft = `first\nsecond\nthird`;

        expect(recallStep(history, `ArrowUp`, draft, 8)).toBeUndefined();
        expect(recallStep(history, `ArrowDown`, draft, 8)).toBeUndefined();
    });

    it(`mirrors the caret step on the way forward: ↓ reaches the end before it steps`, () => {
        const history = stocked();
        recallStep(history, `ArrowUp`, ``, 0);
        recallStep(history, `ArrowUp`, `two`, 3);

        expect(recallStep(history, `ArrowDown`, `one`, 1)).toEqual({ kind: `caret`, at: 3 });
        expect(recallStep(history, `ArrowDown`, `one`, 3)).toEqual({ kind: `text`, text: `two` });
    });

    it(`ignores ↓ and Escape while the composer holds the user's own text`, () => {
        const history = stocked();

        expect(recallStep(history, `ArrowDown`, wrapped, 40)).toBeUndefined();
        expect(recallStep(history, `Escape`, wrapped, 40)).toBeUndefined();
    });

    it(`hands the displaced draft back on Escape, wherever the caret sits`, () => {
        const history = stocked();

        expect(recallStep(history, `ArrowUp`, `half-typed`, 0)).toEqual({ kind: `text`, text: `two` });
        expect(recallStep(history, `Escape`, `two`, 1)).toEqual({ kind: `text`, text: `half-typed` });
    });

    it(`parks the caret even when the ring is empty, so ↑ means one thing in the composer`, () => {
        const history = fresh();

        expect(recallStep(history, `ArrowUp`, wrapped, 40)).toEqual({ kind: `caret`, at: 0 });
        expect(recallStep(history, `ArrowUp`, wrapped, 0)).toBeUndefined();
    });
});

describe(`inputHistoryFor`, () => {
    it(`keeps one ring per sandbox and reuses it`, () => {
        const first = inputHistoryFor(`sandbox-a`);
        expect(inputHistoryFor(`sandbox-a`)).toBe(first);
        expect(inputHistoryFor(`sandbox-b`)).not.toBe(first);

        first.record(`only in a`);
        expect(inputHistoryFor(`sandbox-b`).previous(``)).toBeUndefined();
    });
});
