import { indexAmong, moveEntry } from "./tab-order.js";

const tabs = (...entries: readonly (readonly [string, boolean])[]): Map<string, { open: boolean }> =>
    new Map(entries.map(([id, open]) => [id, { open }]));
const isOpen = (tab: { open: boolean }): boolean => tab.open;

describe("a window's tabs in its strip's order", () => {
    test("a tab moves to the place asked for, the others keeping their order", () => {
        const order = tabs(["a", true], ["b", true], ["c", true], ["d", true]);
        expect(moveEntry(order, "d", 1)).toBe(true);
        expect([...order.keys()]).toEqual(["a", "d", "b", "c"]);
        expect(moveEntry(order, "a", 3)).toBe(true);
        expect([...order.keys()]).toEqual(["d", "b", "c", "a"]);
        expect(moveEntry(order, "c", 0)).toBe(true);
        expect([...order.keys()]).toEqual(["c", "d", "b", "a"]);
    });

    test("a place past the end is the end, and before the start is the start", () => {
        const order = tabs(["a", true], ["b", true], ["c", true]);
        expect(moveEntry(order, "a", 99)).toBe(true);
        expect([...order.keys()]).toEqual(["b", "c", "a"]);
        expect(moveEntry(order, "a", -4)).toBe(true);
        expect([...order.keys()]).toEqual(["a", "b", "c"]);
    });

    test("places count only the open tabs: a closed one the window still holds is stepped over", () => {
        const order = tabs(["a", true], ["x", false], ["b", true], ["c", true]);
        expect(moveEntry(order, "c", 1, isOpen)).toBe(true);
        expect([...order.keys()]).toEqual(["a", "x", "c", "b"]);
        expect(indexAmong(order, "c", isOpen)).toBe(1);
        expect(indexAmong(order, "b", isOpen)).toBe(2);
        expect(indexAmong(order, "x", isOpen)).toBe(-1);
    });

    test("a move to where it already is, or of a tab not there, changes nothing", () => {
        const order = tabs(["a", true], ["b", true]);
        expect(moveEntry(order, "b", 1)).toBe(false);
        expect(moveEntry(order, "nobody", 0)).toBe(false);
        expect([...order.keys()]).toEqual(["a", "b"]);
        expect(indexAmong(order, "nobody")).toBe(-1);
    });
});
