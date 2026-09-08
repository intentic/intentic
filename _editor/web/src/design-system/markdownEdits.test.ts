import { describe, expect, test } from "vitest";
import { continueList, indentLines, insertLink, onListLine, outdentLines, toggleWrap } from "@intentic/ui/markdown";

// Formatting keys and Enter-on-a-list, as edits to markdown source, tested from here beside the block splitter's suite.
// Each case is written the way it is pressed: `|` marks a caret and `[...]` a selection above it, and the assertion is
// what the text becomes.

const sel = (text: string, word: string): [number, number] => [text.indexOf(word), text.indexOf(word) + word.length];

describe(`toggleWrap`, () => {
    test(`wraps the selected words and keeps the selection on them`, () => {
        const text = `make this bold please`;
        const [start, end] = sel(text, `this bold`);
        const edit = toggleWrap(text, start, end, `**`);
        expect(edit.text).toBe(`make **this bold** please`);
        expect(edit.text.slice(edit.start, edit.end)).toBe(`this bold`);
    });

    test(`takes the markers off again when the words inside them are selected`, () => {
        const text = `make **this bold** please`;
        const [start, end] = sel(text, `this bold`);
        const edit = toggleWrap(text, start, end, `**`);
        expect(edit.text).toBe(`make this bold please`);
        expect(edit.text.slice(edit.start, edit.end)).toBe(`this bold`);
    });

    test(`takes them off when the markers were selected too`, () => {
        const text = `make **this bold** please`;
        const [start, end] = sel(text, `**this bold**`);
        const edit = toggleWrap(text, start, end, `**`);
        expect(edit.text).toBe(`make this bold please`);
        expect(edit.text.slice(edit.start, edit.end)).toBe(`this bold`);
    });

    test(`with nothing selected, leaves the caret between the markers so typing lands inside`, () => {
        const text = `write here`;
        const edit = toggleWrap(text, text.length, text.length, `**`);
        expect(edit.text).toBe(`write here****`);
        expect(edit.start).toBe(edit.end);
        expect(edit.text.slice(0, edit.start)).toBe(`write here**`);
    });

    test(`italic is the same rule with one asterisk, and does not mistake bold for it`, () => {
        const text = `a **bold** word`;
        const [start, end] = sel(text, `bold`);
        // The neighbours are `**`, not `*`, so this adds italics inside the bold rather than unwrapping it.
        expect(toggleWrap(text, start, end, `*`).text).toBe(`a ***bold*** word`);
    });

    test(`round-trips: wrapping then unwrapping the same selection gives the text back`, () => {
        const text = `some words here`;
        const [start, end] = sel(text, `words`);
        const wrapped = toggleWrap(text, start, end, `**`);
        expect(toggleWrap(wrapped.text, wrapped.start, wrapped.end, `**`).text).toBe(text);
    });
});

describe(`insertLink`, () => {
    test(`makes the selection the link text and puts the caret in the empty target`, () => {
        const text = `see the docs today`;
        const [start, end] = sel(text, `the docs`);
        const edit = insertLink(text, start, end);
        expect(edit.text).toBe(`see [the docs]() today`);
        // Where the URL goes.
        expect(edit.text.slice(0, edit.start)).toBe(`see [the docs](`);
        expect(edit.start).toBe(edit.end);
    });

    test(`with nothing selected, the caret goes where the words go`, () => {
        const edit = insertLink(`start `, 6, 6);
        expect(edit.text).toBe(`start []()`);
        expect(edit.text.slice(0, edit.start)).toBe(`start [`);
    });
});

describe(`indentLines and outdentLines`, () => {
    test(`indents the line the caret is on`, () => {
        const text = `- one\n- two\n- three`;
        const caret = text.indexOf(`two`);
        expect(indentLines(text, caret, caret).text).toBe(`- one\n  - two\n- three`);
    });

    test(`indents every line a selection touches, including the one it starts in the middle of`, () => {
        const text = `- one\n- two\n- three`;
        const edit = indentLines(text, text.indexOf(`one`), text.indexOf(`two`) + 3);
        expect(edit.text).toBe(`  - one\n  - two\n- three`);
    });

    test(`outdent is its inverse`, () => {
        const text = `- one\n  - two\n- three`;
        const caret = text.indexOf(`two`);
        expect(outdentLines(text, caret, caret).text).toBe(`- one\n- two\n- three`);
    });

    test(`outdent does nothing to a line with no indentation to give back`, () => {
        const text = `- one\n- two`;
        const caret = text.indexOf(`two`);
        expect(outdentLines(text, caret, caret).text).toBe(text);
    });

    test(`a document indented with four spaces outdents a step at a time rather than being reformatted`, () => {
        const text = `- one\n    - two`;
        const caret = text.indexOf(`two`);
        const once = outdentLines(text, caret, caret);
        expect(once.text).toBe(`- one\n  - two`);
        expect(outdentLines(once.text, once.start, once.end).text).toBe(`- one\n- two`);
    });

    test(`a tab counts as one step`, () => {
        const text = `- one\n\t- two`;
        const caret = text.indexOf(`two`);
        expect(outdentLines(text, caret, caret).text).toBe(`- one\n- two`);
    });

    test(`the selection still covers the same words afterwards`, () => {
        const text = `- one\n- two`;
        const [start, end] = sel(text, `two`);
        const edit = indentLines(text, start, end);
        expect(edit.text.slice(edit.start, edit.end)).toBe(`two`);
    });

    test(`a blank line is left alone rather than given trailing whitespace`, () => {
        const text = `- one\n\n- two`;
        const edit = indentLines(text, 0, text.length);
        expect(edit.text).toBe(`  - one\n\n  - two`);
    });
});

describe(`onListLine`, () => {
    const text = `# Heading\n\n- a bullet\n1. numbered\n    - nested\n\nplain prose`;

    test(`knows where Tab means indentation`, () => {
        expect(onListLine(text, text.indexOf(`a bullet`))).toBe(true);
        expect(onListLine(text, text.indexOf(`numbered`))).toBe(true);
        expect(onListLine(text, text.indexOf(`nested`))).toBe(true);
    });

    test(`and where it does not, so the key still moves focus out of the document`, () => {
        expect(onListLine(text, text.indexOf(`Heading`))).toBe(false);
        expect(onListLine(text, text.indexOf(`plain prose`))).toBe(false);
    });
});

// Enter on a list: the affordance that lets a checklist be typed straight through. Each case is the press, with the
// caret at the end of the named line unless stated otherwise.
describe(`continueList`, () => {
    // The caret at the end of the line holding `word`, which is where Enter continues from.
    const endOf = (text: string, word: string): number => {
        const at = text.indexOf(word);
        const next = text.indexOf(`\n`, at);
        return next === -1 ? text.length : next;
    };

    test(`opens the next bullet, and puts the caret after its marker`, () => {
        const text = `- first`;
        const edit = continueList(text, endOf(text, `first`))?.edit;
        expect(edit?.text).toBe(`- first\n- `);
        expect(edit?.start).toBe(edit?.text.length);
    });

    test(`counts an ordered list up by one`, () => {
        const text = `1. first\n2. second`;
        expect(continueList(text, endOf(text, `second`))?.edit.text).toBe(`1. first\n2. second\n3. `);
    });

    test(`keeps the ordered list's own punctuation`, () => {
        const text = `3) third`;
        expect(continueList(text, endOf(text, `third`))?.edit.text).toBe(`3) third\n4) `);
    });

    test(`keeps the indentation, so a nested item stays nested`, () => {
        const text = `- top\n    - nested`;
        expect(continueList(text, endOf(text, `nested`))?.edit.text).toBe(`- top\n    - nested\n    - `);
    });

    test(`opens an UNTICKED box under a ticked one: the next thing has not been done yet`, () => {
        const text = `- [x] done`;
        expect(continueList(text, endOf(text, `done`))?.edit.text).toBe(`- [x] done\n- [ ] `);
    });

    test(`ends the list on an empty item, taking the marker with it`, () => {
        const text = `- one\n- `;
        const ended = continueList(text, text.length);
        expect(ended?.edit.text).toBe(`- one\n`);
        // The caret lands where the marker was, and `ended` tells the surface to open a block there: the empty line
        // does not exist in markdown until typed into.
        expect(ended?.edit.start).toBe(`- one\n`.length);
        expect(ended?.ended).toBe(true);
    });

    // The newline goes with the marker: leaving it behind puts a blank line inside the list, which markdown reads as a
    // loose list rather than the end of one.
    test(`takes the item's newline too, so what follows is not swallowed by the list`, () => {
        const text = `- one\n- \n- three`;
        expect(continueList(text, `- one\n- `.length)?.edit.text).toBe(`- one\n- three`);
    });

    test(`ends a checklist the same way, box and all`, () => {
        const text = `- [ ] `;
        expect(continueList(text, text.length)?.edit.text).toBe(``);
    });

    test(`continuing is not ending, so the surface leaves the caret in the new item`, () => {
        expect(continueList(`- first`, 7)?.ended).toBe(false);
    });

    test(`leaves prose alone, so Enter still means a new paragraph`, () => {
        const text = `Just some prose.`;
        expect(continueList(text, text.length)).toBeUndefined();
    });

    // Mid-item, Enter is a split and markdown has no way to say "half this item", so the key falls through to the
    // surface's ordinary new-block behaviour.
    test(`leaves the caret mid-item alone`, () => {
        const text = `- a long item`;
        expect(continueList(text, text.indexOf(`long`))).toBeUndefined();
    });

    test(`writes into the middle of a document without disturbing what follows`, () => {
        const text = `# Criteria\n\n- one\n- two\n\nAnd some prose after.`;
        expect(continueList(text, endOf(text, `two`))?.edit.text).toBe(`# Criteria\n\n- one\n- two\n- \n\nAnd some prose after.`);
    });
});
