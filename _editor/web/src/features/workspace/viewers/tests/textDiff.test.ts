import { diffSequence, pairEdits, similarity, wordDiff } from "@intentic/ui/diff";

// The kit's diff machinery, tested here beside the readings built on it: the kit has no runner of its own.

const text = (segments: readonly { kind: string; text: string }[], kind: string): string =>
    segments
        .filter((segment) => segment.kind === kind)
        .map((segment) => segment.text)
        .join(``);

describe(`words inside a changed paragraph`, () => {
    it(`marks the words that moved and leaves the rest plain`, () => {
        const segments = wordDiff(`We open at nine every day.`, `We open at eight every weekday.`);
        expect(text(segments, `removed`)).toBe(`nineday`);
        expect(text(segments, `added`)).toBe(`eightweekday`);
        expect(text(segments, `same`)).toBe(`We open at  every .`);
    });

    it(`marks a changed comma as the comma, not the word beside it`, () => {
        const segments = wordDiff(`Bread, cakes and pies`, `Bread, cakes, and pies`);
        expect(segments.filter((segment) => segment.kind === `added`)).toEqual([{ kind: `added`, text: `,` }]);
    });

    it(`draws a phrase as one mark rather than word by word`, () => {
        const segments = wordDiff(`Hello`, `Hello, and welcome to the bakery`);
        expect(segments.filter((segment) => segment.kind === `added`)).toHaveLength(1);
    });
});

describe(`pairing removals with additions`, () => {
    it(`pairs a removed item with the added one that follows it, and leaves the surplus whole`, () => {
        const ops = diffSequence([`a`, `b`, `c`, `d`], [`a`, `B`, `C`, `E`, `d`], (left, right) => left === right)!;
        expect(pairEdits(ops)).toEqual([
            { kind: `same`, before: `a`, after: `a` },
            { kind: `pair`, before: `b`, after: `B` },
            { kind: `pair`, before: `c`, after: `C` },
            { kind: `added`, item: `E` },
            { kind: `same`, before: `d`, after: `d` },
        ]);
    });

    it(`lets the caller veto a pair that is two different items, which then read as removed and added in turn`, () => {
        const ops = diffSequence([`k`, `Refunds are manual.`], [`k`, `The signup spec covers the happy path.`], (left, right) => left === right)!;
        expect(pairEdits(ops, (before, after) => similarity(before, after) >= 0.4)).toEqual([
            { kind: `same`, before: `k`, after: `k` },
            { kind: `removed`, item: `Refunds are manual.` },
            { kind: `added`, item: `The signup spec covers the happy path.` },
        ]);
    });

    it(`measures how much of two texts is the same text`, () => {
        expect(similarity(`We open at nine.`, `We open at nine.`)).toBe(1);
        expect(similarity(`We open at nine.`, `We open at eight.`)).toBeGreaterThan(0.7);
        expect(similarity(`Refunds are manual.`, `The signup spec covers the happy path.`)).toBeLessThan(0.2);
        expect(similarity(``, ``)).toBe(1);
        expect(similarity(`Some`, ``)).toBe(0);
    });

    it(`never pairs across a kept item`, () => {
        const ops = diffSequence([`x`, `k`], [`k`, `y`], (left, right) => left === right)!;
        expect(pairEdits(ops)).toEqual([
            { kind: `removed`, item: `x` },
            { kind: `same`, before: `k`, after: `k` },
            { kind: `added`, item: `y` },
        ]);
    });
});
