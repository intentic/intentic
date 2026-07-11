import { describe, expect, it } from "vitest";
import { closeTabs, type WorkspaceTab } from "./workspaceTabs";

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
