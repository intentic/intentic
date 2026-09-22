import { describe, it, expect } from "bun:test";
import { blocksOf, foldUnchanged, proseDiff } from "./proseDiff";

const text = (segments: readonly { kind: string; text: string }[], kind: string): string =>
    segments
        .filter((segment) => segment.kind === kind)
        .map((segment) => segment.text)
        .join(``);

describe(`paragraphs`, () => {
    it(`splits on blank lines, trims, and accepts Windows line endings`, () => {
        expect(blocksOf(`# Title\r\n\r\nfirst\nline\r\n\r\n\r\n  second  \n`)).toEqual([`# Title`, `first\nline`, `second`]);
    });

    it(`pairs an edited paragraph with itself and words it, while untouched ones stay same`, () => {
        const blocks = proseDiff(`# Menu\n\nWe bake daily.\n\nClosed on Monday.`, `# Menu\n\nWe bake fresh daily.\n\nClosed on Monday.`);
        expect(blocks.map((block) => block.kind)).toEqual([`same`, `changed`, `same`]);
        expect(blocks[0]).toMatchObject({ heading: 1, segments: [{ kind: `same`, text: `Menu` }] });
        expect(text(blocks[1]!.segments, `added`)).toBe(`fresh `);
    });

    it(`stands a new paragraph as added whole and a dropped one as removed whole`, () => {
        const blocks = proseDiff(`One.\n\nTwo.`, `One.\n\nTwo.\n\nThree.`);
        expect(blocks.map((block) => block.kind)).toEqual([`same`, `same`, `added`]);
        expect(proseDiff(`One.\n\nTwo.`, `One.`).map((block) => block.kind)).toEqual([`same`, `removed`]);
    });

    it(`keeps a heading's level off the words it diffs`, () => {
        const [block] = proseDiff(`## Opening hours`, `## Opening times`);
        expect(block).toMatchObject({ kind: `changed`, heading: 2 });
        expect(text(block!.segments, `same`)).toBe(`Opening `);
    });
});

describe(`folding the unchanged`, () => {
    const same = (label: string) => ({ kind: `same` as const, segments: [{ kind: `same` as const, text: label }] });
    const changed = { kind: `changed` as const, segments: [{ kind: `added` as const, text: `x` }] };

    it(`keeps one paragraph of context each side of a change and folds the rest`, () => {
        const runs = foldUnchanged([same(`a`), same(`b`), same(`c`), same(`d`), changed, same(`e`), same(`f`), same(`g`), same(`h`)]);
        expect(
            runs.map((run) => (run.kind === `fold` ? `fold:${run.count}` : run.block.kind === `same` ? run.block.segments[0]!.text : `changed`)),
        ).toEqual([`fold:3`, `d`, `changed`, `e`, `fold:3`]);
    });

    it(`never folds a run so short the fold line would be longer than what it hides`, () => {
        const runs = foldUnchanged([same(`a`), same(`b`), changed]);
        expect(runs.every((run) => run.kind === `block`)).toBe(true);
    });

    it(`shows a document with no change at all in full, since there is nothing to fold towards`, () => {
        const runs = foldUnchanged([same(`a`), same(`b`), same(`c`), same(`d`), same(`e`)]);
        expect(runs).toHaveLength(5);
    });
});
