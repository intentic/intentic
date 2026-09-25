import { headStreak, nextStreak } from "./red-streak.js";

// The five places that asked "is this still the same red" asked it five ways; these are the two answers they share.

describe(`a streak followed one observation at a time`, () => {
    test(`begins at the first red, keeps that start through every red after it, and ends at anything else`, () => {
        const first = nextStreak(undefined, true, 10);
        expect(first).toEqual({ since: 10, count: 1 });
        const second = nextStreak(first, true, 20);
        expect(second).toEqual({ since: 10, count: 2 });
        expect(nextStreak(second, false, 30)).toBeUndefined();
        expect(nextStreak(undefined, false, 30)).toBeUndefined();
    });

    test(`begins again when the red is a different failure`, () => {
        expect(nextStreak({ since: 10, count: 3 }, true, 40, false)).toEqual({ since: 40, count: 1 });
    });
});

describe(`a streak read off a history`, () => {
    test(`is the unbroken run of red at the head, newest first`, () => {
        const history = [`red-3`, `red-2`, `green-1`, `red-0`];
        expect(headStreak(history, (item) => item.startsWith(`red`))).toEqual([`red-3`, `red-2`]);
        expect(headStreak([`green`, `red`], (item) => item === `red`)).toEqual([]);
        expect(headStreak([`red`, `red`], (item) => item === `red`)).toEqual([`red`, `red`]);
        expect(headStreak([], () => true)).toEqual([]);
    });
});
