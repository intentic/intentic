import "@intentic/testing/dom";
import { JUST_SET_UP_MS, justSetUp, markJustSetUp } from "./justSetUp";

// Needs jsdom: the mark survives a reload in the first minutes after /setup opens the workspace, in localStorage.

beforeEach(() => {
    localStorage.clear();
});

describe(`justSetUp`, () => {
    it(`holds for a few minutes after /setup opened the sandbox, then lapses`, () => {
        markJustSetUp(`sbx-1`, 1_000);
        expect(justSetUp(`sbx-1`, 1_000 + JUST_SET_UP_MS)).toBe(true);
        expect(justSetUp(`sbx-2`, 1_000)).toBe(false);
        expect(justSetUp(`sbx-1`, 1_001 + JUST_SET_UP_MS)).toBe(false);
        // The lapsed record is gone, not merely ignored.
        expect(justSetUp(`sbx-1`, 1_000)).toBe(false);
    });

    it(`knows nothing of no sandbox`, () => {
        expect(justSetUp(undefined)).toBe(false);
    });
});
