import { NO_NEWS, newsBetween, type TabFrame, tabMark, tabTitle } from "./tabSignal";

const facts = { asks: 0, offline: false, doneAway: false, working: false };

describe(`the tab's one mark`, () => {
    it(`is none when nothing is going on`, () => {
        expect(tabMark(facts)).toBeUndefined();
    });

    it(`leads with what needs the reader, whatever else holds`, () => {
        expect(tabMark({ asks: 2, offline: true, doneAway: true, working: true })).toEqual({ kind: `asks`, count: 2 });
    });

    it(`says offline over a finish or work under way, which it can no longer vouch for`, () => {
        expect(tabMark({ ...facts, offline: true, doneAway: true, working: true })).toEqual({ kind: `offline` });
    });

    it(`says a finish over work still running`, () => {
        expect(tabMark({ ...facts, doneAway: true, working: true })).toEqual({ kind: `done` });
        expect(tabMark({ ...facts, working: true })).toEqual({ kind: `working` });
    });
});

describe(`the tab's title`, () => {
    it(`is the page and the brand with no mark, or the brand alone`, () => {
        expect(tabTitle(`Agents`, undefined, `Offline`)).toBe(`Agents / intentic`);
        expect(tabTitle(undefined, undefined, `Offline`)).toBe(`intentic`);
    });

    it(`puts the mark in front, where a narrow tab still shows it`, () => {
        expect(tabTitle(`Agents`, { kind: `asks`, count: 3 }, `Offline`)).toBe(`(3) Agents / intentic`);
        expect(tabTitle(`Agents`, { kind: `done` }, `Offline`)).toBe(`✓ Agents / intentic`);
        expect(tabTitle(`Files`, { kind: `offline` }, `Sin conexión`)).toBe(`Sin conexión · Files / intentic`);
    });

    // A title change is what a browser flags on a background tab, so work starting and ending must not make one.
    it(`does not change for work under way`, () => {
        expect(tabTitle(`Agents`, { kind: `working` }, `Offline`)).toBe(`Agents / intentic`);
    });
});

const frame = (over: Partial<TabFrame> = {}): TabFrame => ({ asks: new Map(), working: new Set(), settled: new Set(), ...over });

describe(`news between two readings`, () => {
    it(`is none on the first reading`, () => {
        expect(newsBetween(undefined, frame({ asks: new Map([[`box`, new Set([`a`])]]) }))).toEqual(NO_NEWS);
    });

    it(`is an ask when a source already read gains a caller`, () => {
        const before = frame({ asks: new Map([[`box`, new Set([`a`])]]) });
        expect(newsBetween(before, frame({ asks: new Map([[`box`, new Set([`a`, `b`])]]) }))).toEqual({ asked: true, finished: 0 });
    });

    it(`is none when callers only leave or stay`, () => {
        const before = frame({ asks: new Map([[`box`, new Set([`a`, `b`])]]) });
        expect(newsBetween(before, frame({ asks: new Map([[`box`, new Set([`a`])]]) }))).toEqual(NO_NEWS);
    });

    // A roster's first read and a sandbox switched to both bring everything waiting there at once; none of it is new.
    it(`sets a baseline for a source it has not read before`, () => {
        const before = frame({ asks: new Map([[`box`, new Set()]]) });
        const after = frame({ asks: new Map([[`box`, new Set()], [`other`, new Set([`x`, `y`])]]) });
        expect(newsBetween(before, after)).toEqual(NO_NEWS);
    });

    it(`counts the turns that went from running to Finished`, () => {
        const before = frame({ working: new Set([`box/a`, `box/b`, `box/c`]) });
        const after = frame({ working: new Set([`box/c`]), settled: new Set([`box/a`, `box/b`, `box/old`]) });
        expect(newsBetween(before, after)).toEqual({ asked: false, finished: 2 });
    });

    // Keys carry their sandbox, so a switch never reads as the new box's settled cards having just finished.
    it(`finds no finish across a switch to another sandbox`, () => {
        const before = frame({ working: new Set([`one/a`]) });
        expect(newsBetween(before, frame({ settled: new Set([`two/a`]) }))).toEqual(NO_NEWS);
    });
});
