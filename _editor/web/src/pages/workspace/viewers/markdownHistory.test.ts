import { describe, expect, test } from "vitest";
import { createMarkdownHistory, type DocumentState } from "./markdownHistory";

/* The undo stack behind the markdown editing surface. No DOM: this is about what one press of Ctrl+Z should
 * take back, which is a question about the source and the clock, and both are passed in. */

const at = (text: string, caret = text.length): DocumentState => ({ text, caret });

describe(`what one press undoes`, () => {
    test(`a run of typing is one step, not one per character`, () => {
        const history = createMarkdownHistory();
        history.reset(at(``));
        // "abc" typed quickly.
        history.record(at(`a`), `typing`, 0);
        history.record(at(`ab`), `typing`, 50);
        history.record(at(`abc`), `typing`, 100);
        expect(history.undo()?.text).toBe(``);
    });

    test(`a pause ends the run, so the thinking is where the steps are`, () => {
        const history = createMarkdownHistory();
        history.reset(at(``));
        history.record(at(`a`), `typing`, 0);
        history.record(at(`ab`), `typing`, 50);
        history.record(at(`abc`), `typing`, 5_000);
        expect(history.undo()?.text).toBe(`ab`);
        expect(history.undo()?.text).toBe(``);
    });

    test(`finishing a word ends the run, so Ctrl+Z takes back a word`, () => {
        const history = createMarkdownHistory();
        history.reset(at(``));
        for (const [index, text] of [`h`, `hi`, `hi `, `hi t`, `hi th`, `hi the`].entries()) {
            history.record(at(text), `typing`, index * 10);
        }
        expect(history.undo()?.text).toBe(`hi `);
        expect(history.undo()?.text).toBe(``);
    });

    test(`typing and deleting are never undone together`, () => {
        const history = createMarkdownHistory();
        history.reset(at(``));
        history.record(at(`ab`), `typing`, 0);
        history.record(at(`a`), `deleting`, 10);
        history.record(at(``), `deleting`, 20);
        // The deletions collapse into one step; the typing is still its own.
        expect(history.undo()?.text).toBe(`ab`);
        expect(history.undo()?.text).toBe(``);
    });

    test(`a structural edit is always its own step, however fast it follows`, () => {
        const history = createMarkdownHistory();
        history.reset(at(`a`));
        history.record(at(`a\n\nb`), `structural`, 0);
        history.record(at(`a\n\nbc`), `structural`, 1);
        expect(history.undo()?.text).toBe(`a\n\nb`);
        expect(history.undo()?.text).toBe(`a`);
    });
});

describe(`redo`, () => {
    test(`walks back up the steps that were undone`, () => {
        const history = createMarkdownHistory();
        history.reset(at(``));
        history.record(at(`one`), `structural`, 0);
        history.record(at(`two`), `structural`, 10);
        expect(history.undo()?.text).toBe(`one`);
        expect(history.undo()?.text).toBe(``);
        expect(history.redo()?.text).toBe(`one`);
        expect(history.redo()?.text).toBe(`two`);
    });

    test(`is gone once something else is typed, which replaced that future`, () => {
        const history = createMarkdownHistory();
        history.reset(at(``));
        history.record(at(`one`), `structural`, 0);
        history.record(at(`two`), `structural`, 10);
        history.undo();
        history.record(at(`other`), `structural`, 20);
        expect(history.redo()).toBeUndefined();
    });

    test(`typing after an undo starts a new step rather than joining the one before it`, () => {
        const history = createMarkdownHistory();
        history.reset(at(``));
        history.record(at(`ab`), `typing`, 0);
        history.undo();
        history.record(at(`z`), `typing`, 10);
        // Not folded into the run that was interrupted: undoing returns to the state the undo landed on.
        expect(history.undo()?.text).toBe(``);
    });
});

describe(`edges`, () => {
    test(`says nothing rather than guessing at the ends of history`, () => {
        const history = createMarkdownHistory();
        history.reset(at(`only`));
        expect(history.undo()).toBeUndefined();
        expect(history.redo()).toBeUndefined();
    });

    test(`moving the caret is not a step, but it is remembered for when one is undone`, () => {
        const history = createMarkdownHistory();
        history.reset({ text: `hello`, caret: 5 });
        history.record({ text: `hello`, caret: 0 }, `typing`, 0);
        history.record({ text: `hello!`, caret: 6 }, `typing`, 10);
        const back = history.undo();
        expect(back?.text).toBe(`hello`);
        // The caret comes back where the user actually was, not where they last typed.
        expect(back?.caret).toBe(0);
    });

    test(`a reset forgets the past, which is what opening another file must do`, () => {
        const history = createMarkdownHistory();
        history.reset(at(`first`));
        history.record(at(`first edited`), `structural`, 0);
        history.reset(at(`second`));
        expect(history.undo()).toBeUndefined();
    });

    test(`history is bounded, and it is the oldest steps that go`, () => {
        const history = createMarkdownHistory();
        history.reset(at(`0`));
        for (let step = 1; step <= 400; step += 1) {
            history.record(at(`${step}`), `structural`, step * 1_000);
        }
        let depth = 0;
        while (history.undo() !== undefined) {
            depth += 1;
        }
        expect(depth).toBe(199);
    });
});
