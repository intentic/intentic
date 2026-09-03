import { describe, expect, it } from "vitest";
import { closeTabs, type EditorStrip, emptyPane, moveTab, normalizeStrip, paneOf, placeTab, type WorkspaceTab } from "./workspaceTabs";

const file = (path: string): WorkspaceTab => ({ kind: `file`, id: path, path });
const diff = (id: string, path: string): WorkspaceTab => ({ kind: `diff`, id, label: path, status: `modified`, path });

// a.ts, b.ts, then a diff tab whose id is NOT its path, so we can tell forgetPaths uses file paths only.
const tabs: readonly WorkspaceTab[] = [file(`a.ts`), file(`b.ts`), diff(`diff:1:s/c.ts`, `c.ts`)];
const ids = (list: readonly WorkspaceTab[]): string[] => list.map((tab) => tab.id);
// One pane holding the three tabs above, and nothing beside it: the unsplit editor.
const single = (active: string | null, preview: string | null = null): EditorStrip => ({ main: { tabs, active, preview }, side: emptyPane() });
// The split this feature exists for: a document on the left, the diff it opened on the right.
const split = (): EditorStrip => ({
    main: { tabs: [file(`a.ts`), { kind: `document`, id: `doc:git`, extension: `git-history`, provider: `log`, path: ``, title: `History`, icon: `sitemap` }], active: `doc:git`, preview: null },
    side: { tabs: [diff(`diff:1:s/c.ts`, `c.ts`)], active: `diff:1:s/c.ts`, preview: `diff:1:s/c.ts` },
});

describe(`closeTabs`, () => {
    it(`Close Others keeps only the target and moves the active tab to it`, () => {
        const result = closeTabs(single(`a.ts`), `main`, new Set([`b.ts`, `diff:1:s/c.ts`]));
        expect(ids(result.strip.main.tabs)).toEqual([`a.ts`]);
        expect(result.strip.main.active).toBe(`a.ts`);
    });

    it(`Close to the Right drops only tabs after the index`, () => {
        const result = closeTabs(single(`diff:1:s/c.ts`), `main`, new Set([`diff:1:s/c.ts`]));
        expect(ids(result.strip.main.tabs)).toEqual([`a.ts`, `b.ts`]);
        // active was the closed one → falls back to the last remaining tab.
        expect(result.strip.main.active).toBe(`b.ts`);
    });

    it(`Close All empties the list and clears the active id`, () => {
        const result = closeTabs(single(`a.ts`), `main`, new Set([`a.ts`, `b.ts`, `diff:1:s/c.ts`]));
        expect(result.strip.main.tabs).toEqual([]);
        expect(result.strip.main.active).toBeNull();
    });

    it(`forgets only closed file paths, never diff tabs`, () => {
        const result = closeTabs(single(`a.ts`), `main`, new Set([`b.ts`, `diff:1:s/c.ts`]));
        expect(result.forgetPaths).toEqual([`b.ts`]);
    });

    it(`leaves the active id untouched when the closed tab is not active`, () => {
        const result = closeTabs(single(`a.ts`), `main`, new Set([`b.ts`]));
        expect(result.strip.main.active).toBe(`a.ts`);
    });

    it(`drops a closed tab's preview slot`, () => {
        const result = closeTabs(single(`a.ts`, `b.ts`), `main`, new Set([`b.ts`]));
        expect(result.strip.main.preview).toBeNull();
    });

    // Closing the last diff in the companion pane is how a reader ends a split, so it must not leave an empty
    // column and a focus pointing into it.
    it(`closes the split when the side pane's last tab goes, and gives the focus back`, () => {
        const result = closeTabs(split(), `side`, new Set([`diff:1:s/c.ts`]));
        expect(result.strip.side.tabs).toEqual([]);
        expect(result.focused).toBe(`main`);
        expect(ids(result.strip.main.tabs)).toEqual([`a.ts`, `doc:git`]);
    });

    // The other way round: the reader closes the document they were reading FROM, and the diff they were
    // reading is the only thing left. It takes the whole editor rather than sitting in a right-hand column.
    it(`promotes the side pane when the main pane empties`, () => {
        const result = closeTabs(split(), `main`, new Set([`a.ts`, `doc:git`]));
        expect(ids(result.strip.main.tabs)).toEqual([`diff:1:s/c.ts`]);
        expect(result.strip.main.active).toBe(`diff:1:s/c.ts`);
        expect(result.strip.side.tabs).toEqual([]);
        expect(result.focused).toBe(`main`);
    });
});

describe(`moveTab`, () => {
    it(`opens a split by sending the active tab to the side, focused and kept`, () => {
        const result = moveTab(single(`b.ts`), `b.ts`, `side`);
        expect(ids(result.strip.main.tabs)).toEqual([`a.ts`, `diff:1:s/c.ts`]);
        expect(ids(result.strip.side.tabs)).toEqual([`b.ts`]);
        expect(result.strip.side.active).toBe(`b.ts`);
        expect(result.focused).toBe(`side`);
    });

    // Sending the ONLY tab across is a move to nowhere: normalizeStrip folds it straight back, so the gesture
    // cannot produce an empty main pane beside a full side one.
    it(`refuses to leave the main pane empty`, () => {
        const one: EditorStrip = { main: { tabs: [file(`a.ts`)], active: `a.ts`, preview: null }, side: emptyPane() };
        const result = moveTab(one, `a.ts`, `side`);
        expect(ids(result.strip.main.tabs)).toEqual([`a.ts`]);
        expect(result.strip.side.tabs).toEqual([]);
    });

    it(`brings a tab back from the side, closing the split behind it`, () => {
        const result = moveTab(split(), `diff:1:s/c.ts`, `main`);
        expect(ids(result.strip.main.tabs)).toEqual([`a.ts`, `doc:git`, `diff:1:s/c.ts`]);
        expect(result.strip.side.tabs).toEqual([]);
        expect(result.focused).toBe(`main`);
    });

    it(`does nothing for a tab that is already there, or gone`, () => {
        expect(moveTab(split(), `a.ts`, `main`).strip).toEqual(split());
        expect(moveTab(split(), `closed.ts`, `side`).strip).toEqual(split());
    });
});

describe(`paneOf`, () => {
    it(`names the pane holding a tab, and nothing for one that is closed`, () => {
        expect(paneOf(split(), `doc:git`)).toBe(`main`);
        expect(paneOf(split(), `diff:1:s/c.ts`)).toBe(`side`);
        expect(paneOf(split(), `gone.ts`)).toBeUndefined();
    });
});

describe(`normalizeStrip`, () => {
    it(`leaves a real split alone`, () => {
        const result = normalizeStrip(split(), `side`);
        expect(result.strip).toEqual(split());
        expect(result.focused).toBe(`side`);
    });
});

describe(`placeTab`, () => {
    const incoming = diff(`diff:2:s/d.ts`, `d.ts`);

    it(`appends when nothing is being replaced`, () => {
        expect(ids(placeTab(tabs, incoming, null))).toEqual([`a.ts`, `b.ts`, `diff:1:s/c.ts`, `diff:2:s/d.ts`]);
    });

    // The preview slot keeps its POSITION as the user reads down a list: a tab that jumped to the end on every
    // click would move the thing being looked at out from under the pointer.
    it(`takes the replaced tab's place in the strip`, () => {
        expect(ids(placeTab(tabs, incoming, `b.ts`))).toEqual([`a.ts`, `diff:2:s/d.ts`, `diff:1:s/c.ts`]);
    });

    it(`appends when the tab to replace is gone (its × was clicked)`, () => {
        expect(ids(placeTab(tabs, incoming, `closed.ts`))).toEqual([`a.ts`, `b.ts`, `diff:1:s/c.ts`, `diff:2:s/d.ts`]);
    });

    // Re-opening what is already open refreshes it where it is: one tab per id, always, whatever is being replaced.
    it(`refreshes an already-open tab in place`, () => {
        const refreshed = diff(`diff:1:s/c.ts`, `c.ts`);
        const result = placeTab(tabs, refreshed, `a.ts`);
        expect(ids(result)).toEqual([`a.ts`, `b.ts`, `diff:1:s/c.ts`]);
        expect(result[2]).toBe(refreshed);
    });
});
