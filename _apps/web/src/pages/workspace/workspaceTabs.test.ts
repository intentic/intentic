import { describe, expect, it } from "vitest";
import { closeTabs, placeTab, type WorkspaceTab } from "./workspaceTabs";

const file = (path: string): WorkspaceTab => ({ kind: `file`, id: path, path });
const diff = (id: string, path: string): WorkspaceTab => ({ kind: `diff`, id, label: path, status: `modified`, path });

// a.ts, b.ts, then a diff tab whose id is NOT its path — so we can tell forgetPaths uses file paths only.
const tabs: readonly WorkspaceTab[] = [file(`a.ts`), file(`b.ts`), diff(`diff:1:s/c.ts`, `c.ts`)];
const ids = (list: readonly WorkspaceTab[]): string[] => list.map((tab) => tab.id);

describe(`closeTabs`, () => {
    it(`Close Others keeps only the target and moves the active tab to it`, () => {
        const result = closeTabs(tabs, `a.ts`, new Set([`b.ts`, `diff:1:s/c.ts`]));
        expect(ids(result.nextTabs)).toEqual([`a.ts`]);
        expect(result.nextActiveId).toBe(`a.ts`);
    });

    it(`Close to the Right drops only tabs after the index`, () => {
        const result = closeTabs(tabs, `diff:1:s/c.ts`, new Set([`diff:1:s/c.ts`]));
        expect(ids(result.nextTabs)).toEqual([`a.ts`, `b.ts`]);
        // active was the closed one → falls back to the last remaining tab.
        expect(result.nextActiveId).toBe(`b.ts`);
    });

    it(`Close All empties the list and clears the active id`, () => {
        const result = closeTabs(tabs, `a.ts`, new Set([`a.ts`, `b.ts`, `diff:1:s/c.ts`]));
        expect(result.nextTabs).toEqual([]);
        expect(result.nextActiveId).toBeNull();
    });

    it(`forgets only closed file paths, never diff tabs`, () => {
        const result = closeTabs(tabs, `a.ts`, new Set([`b.ts`, `diff:1:s/c.ts`]));
        expect(result.forgetPaths).toEqual([`b.ts`]);
    });

    it(`leaves the active id untouched when the closed tab is not active`, () => {
        const result = closeTabs(tabs, `a.ts`, new Set([`b.ts`]));
        expect(result.nextActiveId).toBe(`a.ts`);
    });
});

describe(`placeTab`, () => {
    const incoming = diff(`diff:2:s/d.ts`, `d.ts`);

    it(`appends when nothing is being replaced`, () => {
        expect(ids(placeTab(tabs, incoming, null))).toEqual([`a.ts`, `b.ts`, `diff:1:s/c.ts`, `diff:2:s/d.ts`]);
    });

    // The preview slot keeps its POSITION as the user reads down a list — a tab that jumped to the end on every
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
