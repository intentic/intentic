// @vitest-environment jsdom
//
// The rules the rail and the most-added-first order rest on. `readingOf` is a thin binding of `shownStat` to the
// showComments preference and is exercised through the panels. jsdom for the module, not for these assertions:
// the file also declares a stored preference and reaches useLayout, both of which read the document as they load.
import { describe, expect, it } from "vitest";
import { addedIn, bigger, shownStat, sumCode, sumShown, weightFill } from "./changeWeight";

describe(`shownStat`, () => {
    it(`shows the code-only counts while the surface is showing code alone`, () => {
        expect(shownStat(true, { additions: 4, deletions: 1 }, 26, 9)).toEqual({ additions: 4, deletions: 1 });
    });

    it(`shows git's counts once comments are back on, even with a code reading in hand`, () => {
        expect(shownStat(false, { additions: 4, deletions: 1 }, 26, 9)).toEqual({ additions: 26, deletions: 9 });
    });

    // A file the daemon could not read as code (bytes, no grammar, one side too large) carries no `code` at all:
    // git's numbers ARE its reading, and its rail has to be scaled the same way.
    it(`falls back to git's for a file there was no code reading of`, () => {
        expect(shownStat(true, undefined, 26, 9)).toEqual({ additions: 26, deletions: 9 });
    });

    // A binary file or a conflict: no count on either side. The caller draws no rail rather than an empty one,
    // which would claim a size of zero for something whose size is unknown.
    it(`keeps "no answer" distinguishable from zero`, () => {
        expect(shownStat(true, undefined, undefined, undefined)).toEqual({ additions: undefined, deletions: undefined });
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

describe(`sumCode`, () => {
    it(`totals the code-only readings a heading is drawing`, () => {
        expect(sumCode([{ code: { additions: 4, deletions: 1 }, additions: 26, deletions: 9 }, { code: { additions: 2, deletions: 0 } }])).toEqual({
            additions: 6,
            deletions: 1,
        });
    });

    /* A row there is no code reading OF contributes git's own, which is what its badge shows too: a heading that
     * left it out would disagree with the rows under it, and one that counted it as zero would say a 400-line
     * vendored bundle changed nothing. */
    it(`takes git's numbers for a row that could not be read as code`, () => {
        expect(sumCode([{ code: { additions: 4, deletions: 1 } }, { additions: 40, deletions: 2 }])).toEqual({ additions: 44, deletions: 3 });
    });

    it(`totals nothing to nothing, so an emptied group draws an empty badge`, () => {
        expect(sumCode([])).toEqual({ additions: 0, deletions: 0 });
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
