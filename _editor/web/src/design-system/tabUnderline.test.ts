// jsdom for the IMPORT, not the assertions: `ui` is a pure class-string builder, but @intentic/ui's only door is the
// barrel, which loads useTheme and touches `document` at module scope.
//
// The two facts `ui.tab` exists to hold still, for the strips that draw a "which view am I on" row: the workspace's
// file tabs and `SegmentedControl variant="underline"`. Both are about the row not MOVING when the selection does,
// which is invisible in a screenshot of either state on its own. Lives here rather than beside the recipe because
// @intentic/ui has no test runner; turbo re-runs this whenever the kit changes, since web depends on it.
import "@intentic/testing/dom";
import { it, expect } from "bun:test";
import { ui } from "@intentic/ui";

const classesOf = (active: boolean, ...overrides: string[]): string[] => ui.tab(active, ...overrides).split(/\s+/).filter(Boolean);

// A rule that appeared only under the active tab would add 2px to that tab's height on selection, dropping the row
// below by 2px every time the reader switched.
it("gives both states a rule of the same weight, so selecting one moves nothing", () => {
    expect(classesOf(true)).toContain(`border-b-2`);
    expect(classesOf(false)).toContain(`border-b-2`);
    expect(classesOf(true)).toContain(`border-b-primary-500`);
    expect(classesOf(false)).toContain(`border-b-transparent`);
});

// Weight is the tempting third signal and the one that cannot be afforded: a bolder label is a WIDER label, so the
// tabs beside it shift by a pixel on every switch. Measured on the chat rail: "Personas" went 51px → 52px.
it("carries the state in ink and rule, never in weight", () => {
    for (const state of [true, false]) {
        expect(classesOf(state).filter((name) => name.startsWith(`font-`))).toEqual([]);
    }
    expect(classesOf(true)).toContain(`text-content`);
    expect(classesOf(false)).toContain(`text-muted`);
});

// The strip owns its own fill and separators; a caller's override has to win, or FileTabs could not keep the canvas
// fill that distinguishes its active tab from the toolbar it sits on.
it("lets the strip override what it owns", () => {
    expect(classesOf(true, `bg-canvas`)).toContain(`bg-canvas`);
    expect(classesOf(false, `hover:bg-content/6`)).toContain(`hover:bg-content/6`);
});
