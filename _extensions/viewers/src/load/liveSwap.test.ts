import { blockTexts, changedLines, FOLLOW_ATTRIBUTE, holdScroll, markChanged, newBlocks, swapChildren } from "./liveSwap";

// A document drawn again while it is read (an agent rewriting the file): what changed is found, what failed to draw
// leaves the last rendering, and the reader's place is kept.

const paragraphs = (...texts: readonly string[]): HTMLElement => {
    const host = document.createElement(`div`);
    for (const text of texts) {
        const p = document.createElement(`p`);
        p.textContent = text;
        host.append(p);
    }
    return host;
};

describe(`newBlocks`, () => {
    it(`finds the blocks whose text is new, in document order`, () => {
        const before = blockTexts(paragraphs(`Intro`, `Body`));
        const after = paragraphs(`Intro`, `Body, extended`, `Conclusion`);
        expect(newBlocks(before, after).map((block) => block.textContent)).toEqual([`Body, extended`, `Conclusion`]);
    });

    it(`counts a repeated paragraph once per copy`, () => {
        const before = blockTexts(paragraphs(`Same`));
        expect(newBlocks(before, paragraphs(`Same`, `Same`))).toHaveLength(1);
    });

    it(`looks at the innermost blocks, so a changed cell is new and not its whole table`, () => {
        const host = document.createElement(`div`);
        host.innerHTML = `<table><tr><td><p>a</p></td><td>b</td></tr></table>`;
        const before = blockTexts(host);
        const after = document.createElement(`div`);
        after.innerHTML = `<table><tr><td><p>a</p></td><td>c</td></tr></table>`;
        expect(newBlocks(before, after).map((block) => block.tagName)).toEqual([`TD`]);
    });

    it(`never counts an empty block`, () => {
        expect(newBlocks(new Map(), paragraphs(``, `   `))).toEqual([]);
    });
});

describe(`swapChildren`, () => {
    it(`replaces the host's children with what was built`, async () => {
        const host = paragraphs(`old`);
        const swapped = await swapChildren(host, (staging) => void staging.append(paragraphs(`new`)), false);
        expect(swapped).toBe(true);
        expect(host.textContent).toBe(`new`);
    });

    it(`leaves the last rendering when the build throws, as a file read mid-write does`, async () => {
        const host = paragraphs(`last good`);
        await expect(
            swapChildren(
                host,
                () => {
                    throw new Error(`end of central directory not found`);
                },
                true,
            ),
        ).rejects.toThrow(`central directory`);
        expect(host.textContent).toBe(`last good`);
    });

    it(`swaps nothing when the build answers that a newer load took over`, async () => {
        const host = paragraphs(`current`);
        expect(await swapChildren(host, () => false, true)).toBe(false);
        expect(host.textContent).toBe(`current`);
    });

    it(`puts the reader's scroll back after the swap`, async () => {
        const host = paragraphs(`a`);
        host.scrollTop = 120;
        await swapChildren(host, (staging) => void staging.append(paragraphs(`b`)), true);
        expect(host.scrollTop).toBe(120);
    });
});

describe(`holdScroll`, () => {
    it(`puts back every scrolled element from the start up`, () => {
        const outer = document.createElement(`div`);
        const inner = document.createElement(`div`);
        outer.append(inner);
        outer.scrollTop = 40;
        inner.scrollLeft = 7;
        const restore = holdScroll(inner);
        outer.scrollTop = 0;
        inner.scrollLeft = 0;
        restore();
        expect(outer.scrollTop).toBe(40);
        expect(inner.scrollLeft).toBe(7);
    });
});

describe(`markChanged`, () => {
    it(`brings the first change into view only where the host asks to follow the edits`, () => {
        const seen: string[] = [];
        const host = paragraphs(`a`, `b`, `c`, `d`);
        const [first] = [...host.querySelectorAll(`p`)];
        first!.scrollIntoView = () => void seen.push(first!.textContent ?? ``);
        markChanged(host, [first!]);
        expect(seen).toEqual([]);

        const followed = document.createElement(`div`);
        followed.setAttribute(FOLLOW_ATTRIBUTE, `true`);
        followed.append(host);
        markChanged(host, [first!]);
        expect(seen).toEqual([`a`]);
    });

    it(`lights nothing when most of the document changed, since that is a replacement rather than an edit`, () => {
        const host = paragraphs(`a`, `b`);
        const lit: Element[] = [];
        for (const block of host.querySelectorAll<HTMLElement>(`p`)) {
            // Only whether it was called matters; the test DOM has no animations to hand back.
            Object.defineProperty(block, `animate`, { value: () => void lit.push(block) });
        }
        markChanged(host, [...host.querySelectorAll<HTMLElement>(`p`)]);
        expect(lit).toEqual([]);
    });
});

describe(`changedLines`, () => {
    const lines = (count: number): string[] => Array.from({ length: count }, (_, index) => `line ${index + 1}`);

    it(`spans the lines an edit touched`, () => {
        const before = lines(10);
        const after = [...before];
        after[3] = `changed`;
        after[5] = `changed too`;
        expect(changedLines(before.join(`\n`), after.join(`\n`))).toEqual({ first: 4, last: 6 });
    });

    it(`marks appended lines`, () => {
        expect(changedLines(lines(10).join(`\n`), [...lines(10), `new`].join(`\n`))).toEqual({ first: 11, last: 11 });
    });

    it(`marks where a deletion closed the text up`, () => {
        const before = lines(10);
        const after = before.filter((_, index) => index !== 4);
        expect(changedLines(before.join(`\n`), after.join(`\n`))).toEqual({ first: 5, last: 5 });
    });

    it(`says nothing for no change, or for a rewrite of most of the text`, () => {
        expect(changedLines(`a\nb`, `a\nb`)).toBeUndefined();
        expect(changedLines(lines(10).join(`\n`), lines(10).map((line) => `${line}!`).join(`\n`))).toBeUndefined();
    });
});
