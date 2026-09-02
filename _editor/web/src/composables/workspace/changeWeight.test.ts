// @vitest-environment jsdom
//
// The rules the rail and the most-added-first order rest on. `readingOf` is a thin binding of `shownStat` to the
// showComments preference and is exercised through the panels; the order half is here, since which pair a list
// is sorted on is the whole of it. jsdom for the module, not for these assertions: the file also declares a
// stored preference and reaches useLayout, both of which read the document as they load.
import { describe, expect, it } from "vitest";
import { nextTick, ref } from "vue";
import { addedIn, bigger, orderStat, shownStat, sumShown, useChangeWeight, weightFill } from "./changeWeight";

describe(`shownStat`, () => {
    it(`shows the code-only counts while the surface is showing code alone`, () => {
        expect(shownStat(true, { code: { additions: 4, deletions: 1 }, counting: false }, 26, 9)).toEqual({ additions: 4, deletions: 1 });
    });

    it(`shows git's counts once comments are back on, even with a code reading in hand`, () => {
        expect(shownStat(false, { code: { additions: 4, deletions: 1 }, counting: false }, 26, 9)).toEqual({ additions: 26, deletions: 9 });
    });

    it(`falls back to git's while the code reading is still being worked out`, () => {
        expect(shownStat(true, { counting: true }, 26, 9)).toEqual({ additions: 26, deletions: 9 });
    });

    // A file with nothing to strip (bytes, no grammar, an oversized diff sent as an excerpt) settles with no
    // `code`: git's numbers ARE its code-only reading, and its rail has to be scaled the same way.
    it(`falls back to git's for a file there was nothing to strip`, () => {
        expect(shownStat(true, { counting: false }, 26, 9)).toEqual({ additions: 26, deletions: 9 });
    });

    // A binary file or a conflict: no count on either side. The caller draws no rail rather than an empty one,
    // which would claim a size of zero for something whose size is unknown.
    it(`keeps "no answer" distinguishable from zero`, () => {
        expect(shownStat(true, { counting: false }, undefined, undefined)).toEqual({ additions: undefined, deletions: undefined });
    });
});

describe(`addedIn`, () => {
    /* THE DECISION THE WHOLE FILE TURNS ON. Deletions are cheap to review and, measured as size, hand the scale
     * to whatever the changeset happened to delete: one removed 1,353-line bundle is enough to rank a 131-line
     * rewrite below a deleted Dockerfile. Added lines are what has to be read. */
    it(`measures the lines that have to be read, not total churn`, () => {
        expect(addedIn({ additions: 131, deletions: 35 })).toBe(131);
        expect(addedIn({ additions: 0, deletions: 1353 })).toBe(0);
    });

    it(`reads a missing side as none of it`, () => {
        expect(addedIn({})).toBe(0);
        expect(addedIn({ deletions: 4 })).toBe(0);
    });
});

describe(`bigger`, () => {
    it(`puts the file that added most first, whatever either deleted`, () => {
        expect(bigger({ additions: 131, deletions: 0 }, { additions: 12, deletions: 900 })).toBeLessThan(0);
    });

    // Which is what keeps a changeset of pure deletions from collapsing into an arbitrary order under a control
    // the user just asked to sort it.
    it(`falls back to deletions when nothing was added`, () => {
        expect(bigger({ additions: 0, deletions: 900 }, { additions: 0, deletions: 12 })).toBeLessThan(0);
    });

    it(`leaves equals alone, so a stable sort keeps them in path order`, () => {
        expect(bigger({ additions: 4, deletions: 1 }, { additions: 4, deletions: 1 })).toBe(0);
    });
});

describe(`orderStat`, () => {
    it(`takes git's pair off whatever carries it, a row's change or a heading's totals`, () => {
        // A row as the panel holds it: git's pair, and the code-only reading that arrived for it later.
        const row = { additions: 40, deletions: 2, code: { additions: 2, deletions: 0 } };
        expect(orderStat(row)).toEqual({ additions: 40, deletions: 2 });
        expect(orderStat(sumShown([{ additions: 40, deletions: 2 }, { additions: 8 }]))).toEqual({ additions: 48, deletions: 2 });
    });

    it(`carries "no counts at all" through rather than calling a binary file a change of zero`, () => {
        expect(orderStat({})).toEqual({ additions: undefined, deletions: undefined });
    });
});

/* THE JUMP THIS EXISTS TO STOP. The order used to take each row's shown reading the moment that reading arrived,
 * and the readings arrive one file at a time — in the background, and on the click that opens one — so a review
 * re-sorted itself as it was read, and the click that selected a row was the thing that moved it. The switch to
 * the shown reading now happens once, for the whole list, and never once the reader has touched it. */
describe(`orderReading`, () => {
    const { orderReading, largestFirst } = useChangeWeight();
    const COUNTED = { code: { additions: 2, deletions: 0 }, counting: false };

    it(`ranks on git's pair until every row on screen has been counted`, async () => {
        const counted = ref(false);
        const key = orderReading(
            () => counted.value,
            () => false,
        );
        expect(key(COUNTED, 40, 2)).toEqual({ additions: 40, deletions: 2 });

        // The list is counted whole: one switch, and from here the key is the reading the badges are drawing.
        counted.value = true;
        await nextTick();
        expect(key(COUNTED, 40, 2)).toEqual({ additions: 2, deletions: 0 });
    });

    /* A latch, not a condition. An agent writing into an open review adds rows that have not been counted, and a
     * key that fell back to git's for the whole list every time would re-sort it twice per file the agent wrote:
     * once on the way out, once on the way back. The new row ranks on git's pair until its own count lands. */
    it(`stays on the shown reading when a later row arrives uncounted`, async () => {
        const counted = ref(true);
        const key = orderReading(
            () => counted.value,
            () => false,
        );
        await nextTick();
        expect(key(COUNTED, 40, 2)).toEqual({ additions: 2, deletions: 0 });

        counted.value = false;
        await nextTick();
        expect(key(COUNTED, 40, 2)).toEqual({ additions: 2, deletions: 0 });
        // …and the row that has not been counted yet is the one holding git's numbers, which is where it sorts.
        expect(key({ counting: true }, 8, 1)).toEqual({ additions: 8, deletions: 1 });
    });

    it(`never switches under a reader who has already picked a row`, async () => {
        const counted = ref(false);
        const touched = ref(false);
        const key = orderReading(
            () => counted.value,
            () => touched.value,
        );

        // They clicked before the counting finished: this list keeps the order it had, however late it settles.
        touched.value = true;
        counted.value = true;
        await nextTick();
        expect(key(COUNTED, 40, 2)).toEqual({ additions: 40, deletions: 2 });

        // Working the control is the reader asking to be re-ordered, and is the way back out of that freeze.
        largestFirst.value = !largestFirst.value;
        await nextTick();
        expect(key(COUNTED, 40, 2)).toEqual({ additions: 2, deletions: 0 });
        largestFirst.value = false;
    });
});

describe(`bySize`, () => {
    const { largestFirst, bySize } = useChangeWeight();
    const rows = [
        { path: `a/prose.ts`, additions: 40, deletions: 2 },
        { path: `b/parse.ts`, additions: 30, deletions: 9 },
        { path: `c/tweak.ts`, additions: 30, deletions: 1 },
    ];

    it(`hands back the very same list while path order is the reading, so it costs a panel nothing`, () => {
        largestFirst.value = false;
        expect(bySize(rows, orderStat)).toBe(rows);
    });

    it(`puts the most added first and breaks a tie on deletions, leaving path order under both`, () => {
        largestFirst.value = true;
        try {
            expect(bySize(rows, orderStat).map((row) => row.path)).toEqual([`a/prose.ts`, `b/parse.ts`, `c/tweak.ts`]);
        } finally {
            largestFirst.value = false;
        }
    });
});

describe(`sumShown`, () => {
    it(`totals a heading's rows on both sides`, () => {
        expect(sumShown([{ additions: 4, deletions: 1 }, { additions: 10 }, { deletions: 3 }])).toEqual({ additions: 14, deletions: 4 });
    });

    it(`totals nothing to nothing rather than to undefined`, () => {
        expect(sumShown([])).toEqual({ additions: 0, deletions: 0 });
    });
});

describe(`weightFill`, () => {
    it(`fills the track for the file that added most`, () => {
        expect(weightFill(200, 200)).toBe(1);
    });

    // The whole point of the compressive scale: on a linear one a 20-line file beside a 2,000-line one draws 1%
    // of 20px, which is nothing, and the list is back to being unrankable.
    it(`keeps a small change against a huge one visible and ordered`, () => {
        const small = weightFill(20, 2000);
        const middling = weightFill(200, 2000);
        expect(small).toBeGreaterThan(0.09);
        expect(middling).toBeGreaterThan(small);
        expect(middling).toBeLessThan(1);
    });

    it(`never draws a stub too small to see`, () => {
        expect(weightFill(1, 5000)).toBeGreaterThanOrEqual(0.14);
    });

    it(`draws nothing for a change that added nothing, and cannot divide by a list that added nothing`, () => {
        expect(weightFill(0, 200)).toBe(0);
        expect(weightFill(12, 0)).toBe(0);
    });

    it(`never overflows its track`, () => {
        expect(weightFill(500, 200)).toBe(1);
    });
});
