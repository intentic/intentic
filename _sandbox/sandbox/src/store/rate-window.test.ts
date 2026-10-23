import { rateWindow } from "./rate-window.js";

test("a caller is counted and refused at the limit", () => {
    const window = rateWindow(60_000);
    expect(window.limited("visitor", 2, 0)).toBe(false);
    expect(window.limited("visitor", 2, 1)).toBe(false);
    expect(window.limited("visitor", 2, 2)).toBe(true);
    expect(window.size()).toBe(1);
    expect(window.limited("visitor", 2, 60_001)).toBe(false);
});

test("a periodic sweep removes expired callers throughout the map", () => {
    const window = rateWindow(60_000);
    window.limited("first", 1, 0);
    window.limited("second", 1, 0);
    expect(window.size()).toBe(2);

    window.limited("next", 1, 60_000);
    expect(window.size()).toBe(1);
});

test("attacker-chosen callers cannot grow the map past its hard ceiling", () => {
    const window = rateWindow(60_000, 100);
    for (let caller = 0; caller < 5_000; caller += 1) {
        expect(window.limited(`visitor-${caller}`, 1, 1)).toBe(false);
    }
    expect(window.size()).toBe(100);
});

test("the capacity eviction is least-recently-used, including a refused caller's activity", () => {
    const window = rateWindow(60_000, 2);
    expect(window.limited("keep", 1, 0)).toBe(false);
    expect(window.limited("evict", 1, 0)).toBe(false);
    expect(window.limited("keep", 1, 1)).toBe(true);
    expect(window.limited("new", 1, 2)).toBe(false);
    expect(window.limited("keep", 1, 2)).toBe(true);

    // The old entry would still be at its limit; its reset proves it was the one evicted.
    expect(window.limited("evict", 1, 3)).toBe(false);
    expect(window.size()).toBe(2);
});
