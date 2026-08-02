import { describe, expect, it } from "vitest";

// No mocks and no mount. Every rule takes rows and a viewed set and returns a value — the panel's own reactivity
// is what these were extracted OUT of, so a group here is just a list of keys.
import { groupCountLabel, groupPassOn, rowAfterGroup, viewedIn } from "./reviewGroupPass";

const rows = (...keys: readonly string[]): readonly { key: string }[] => keys.map((key) => ({ key }));
const seen = (...keys: readonly string[]): ReadonlySet<string> => new Set(keys);

describe("viewedIn", () => {
    it("counts only the group's own rows, ignoring viewed files from elsewhere", () => {
        expect(viewedIn(rows(`a`, `b`, `c`), seen(`a`, `c`, `zz`))).toBe(2);
    });
});

// The tri-state click. The middle case is the one that matters: it is what makes "I read three, the rest of the
// package is fine" a single gesture.
describe("groupPassOn", () => {
    it("ticks the rest off from a partly-read group", () => {
        expect(groupPassOn(rows(`a`, `b`, `c`), seen(`a`))).toBe(true);
    });

    it("ticks an untouched group on", () => {
        expect(groupPassOn(rows(`a`, `b`), seen())).toBe(true);
    });

    // Without this the control has no undo, and a mis-click costs N row clicks to walk back.
    it("un-ticks a fully-read group, so a second click is the first click's undo", () => {
        expect(groupPassOn(rows(`a`, `b`), seen(`a`, `b`))).toBe(false);
    });
});

describe("groupCountLabel", () => {
    it("shows a fraction mid-pass — the answer to 'how far into this package am I'", () => {
        expect(groupCountLabel(rows(`a`, `b`, `c`), seen(`b`))).toBe(`1/3`);
    });

    it("shows the bare total at both ends of the pass, where the tick already says it", () => {
        expect(groupCountLabel(rows(`a`, `b`), seen())).toBe(`2`);
        expect(groupCountLabel(rows(`a`, `b`), seen(`a`, `b`))).toBe(`2`);
    });
});

/* Where ⇧V lands. `visible` is render order across every repo — so these cases are the real ones: a group in the
 * middle of the list, the group at the tail, and a group that is drawing nothing because its repo is collapsed. */
describe("rowAfterGroup", () => {
    const visible = rows(`a1`, `a2`, `b1`, `b2`, `c1`);

    it("lands past the group's LAST row, not back inside rows it just ticked", () => {
        expect(rowAfterGroup(visible, rows(`a1`, `a2`))?.key).toBe(`b1`);
    });

    it("stays put on the tail group rather than wrapping to the top", () => {
        expect(rowAfterGroup(visible, rows(`c1`))).toBeUndefined();
    });

    // Ticking a collapsed repo's group off is legitimate — the selection survives a collapse — and moves nothing.
    it("stays put when the group draws no visible rows at all", () => {
        expect(rowAfterGroup(visible, rows(`hidden1`, `hidden2`))).toBeUndefined();
    });

    // Grouping reorders a repo's rows, so a group's rows need not be contiguous in render order; the row after
    // the last one is still the honest place to land.
    it("measures from the last row even when the group is not contiguous", () => {
        expect(rowAfterGroup(visible, rows(`a1`, `b2`))?.key).toBe(`c1`);
    });
});
