import { MAX_SCROLL_NOTCHES, perform } from "./actions.js";
import type { Desktop, Point, ScrollDirection } from "./types.js";
import type { Pointing } from "./view.js";

/* One agent action carried out on a desktop, through a desktop that records what it was asked. */

const scrolls: { at: Point; direction: ScrollDirection; amount: number }[] = [];
const screen = {
    scroll: async (at: Point, direction: ScrollDirection, amount: number) => {
        scrolls.push({ at, direction, amount });
    },
} as unknown as Desktop;
const pointing: Pointing = { point: async (at) => at, element: async () => ({ x: 0, y: 0 }) };

beforeEach(() => {
    scrolls.length = 0;
});

// xdotool is asked to click once per notch and is killed after 15 s; a model's 100000000 held the call that long and
// answered with an error about a missing browser pack.
test("a scroll is capped at a few dozen notches, however many the call asks for", async () => {
    await perform(screen, { action: "scroll", coordinate: [5, 6], direction: "down", amount: 100_000_000 }, pointing);
    expect(scrolls).toEqual([{ at: { x: 5, y: 6 }, direction: "down", amount: MAX_SCROLL_NOTCHES }]);
    expect(MAX_SCROLL_NOTCHES).toBeLessThanOrEqual(100);
});

test("an ordinary scroll is passed through, and the default is three notches", async () => {
    await perform(screen, { action: "scroll", coordinate: [1, 2], direction: "up", amount: 7 }, pointing);
    await perform(screen, { action: "scroll", coordinate: [1, 2] }, pointing);
    expect(scrolls.map((scroll) => scroll.amount)).toEqual([7, 3]);
});
