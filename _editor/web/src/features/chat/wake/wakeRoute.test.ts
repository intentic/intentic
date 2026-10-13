import { alternativeOf, FOLLOW_UP_MS, lastSaidAt, routeWake, type WakeSituation, type WakeTarget } from "./wakeRoute";

// Pins where words said to the agent by name go: on into a conversation only on a clear sign of an exchange under way,
// a new session otherwise, and the switch offered while they wait points at the other of the two.

const NOW = 1_800_000_000_000;
const target = (id: string, fields: Partial<WakeTarget> = {}): WakeTarget => ({ id, asking: false, running: false, lastSaidAt: undefined, ...fields });
const situation = (fields: Partial<WakeSituation> = {}): WakeSituation => ({ now: NOW, askedForNew: false, thread: undefined, onScreen: undefined, ...fields });
const minutesAgo = (minutes: number): number => NOW - minutes * 60_000;

describe(`routeWake`, () => {
    test(`asking for a new session gets one, whatever is under way`, () => {
        expect(
            routeWake(situation({ askedForNew: true, thread: target(`a`, { lastSaidAt: minutesAgo(1), asking: true }), onScreen: target(`b`, { running: true }) })),
        ).toEqual({ kind: `new`, why: `asked` });
    });

    test(`a card waiting in the conversation being talked to takes the words as its answer, the last wake's first`, () => {
        expect(routeWake(situation({ thread: target(`a`, { lastSaidAt: minutesAgo(2), asking: true }), onScreen: target(`b`, { asking: true, running: true }) }))).toEqual({
            kind: `answer`,
            id: `a`,
            why: `thread`,
        });
        expect(routeWake(situation({ onScreen: target(`b`, { asking: true, lastSaidAt: minutesAgo(3) }) }))).toEqual({ kind: `answer`, id: `b`, why: `screen` });
    });

    test(`a card asked long ago is not an exchange under way, so it is not answered by a call across the room`, () => {
        expect(routeWake(situation({ onScreen: target(`b`, { asking: true, lastSaidAt: minutesAgo(45) }) }))).toEqual({ kind: `new`, why: `nothing-recent` });
    });

    test(`the last wake's conversation goes on while that exchange is recent, even when another chat is on screen`, () => {
        expect(routeWake(situation({ thread: target(`a`, { lastSaidAt: minutesAgo(9) }), onScreen: target(`b`, { lastSaidAt: minutesAgo(1) }) }))).toEqual({
            kind: `continue`,
            id: `a`,
            why: `thread`,
        });
    });

    test(`the chat on screen goes on when something was said in it recently, or it is working`, () => {
        expect(routeWake(situation({ thread: target(`a`, { lastSaidAt: minutesAgo(30) }), onScreen: target(`b`, { lastSaidAt: minutesAgo(4) }) }))).toEqual({
            kind: `continue`,
            id: `b`,
            why: `screen`,
        });
        expect(routeWake(situation({ onScreen: target(`b`, { running: true, lastSaidAt: minutesAgo(90) }) }))).toEqual({ kind: `continue`, id: `b`, why: `screen` });
    });

    test(`anything else is a new session: an old chat on screen, an empty one, nothing at all`, () => {
        expect(routeWake(situation({ onScreen: target(`b`, { lastSaidAt: NOW - FOLLOW_UP_MS }) }))).toEqual({ kind: `new`, why: `nothing-recent` });
        expect(routeWake(situation({ onScreen: target(`b`) }))).toEqual({ kind: `new`, why: `nothing-recent` });
        expect(routeWake(situation())).toEqual({ kind: `new`, why: `nothing-recent` });
    });
});

describe(`alternativeOf`, () => {
    test(`words bound for a conversation can go to a new session instead`, () => {
        const here = situation({ onScreen: target(`b`, { lastSaidAt: minutesAgo(1) }) });
        expect(alternativeOf(routeWake(here), here)).toEqual({ kind: `new`, why: `asked` });
    });

    test(`words bound for a new session can go on in the conversation nearest to being continued`, () => {
        const both = situation({ thread: target(`a`, { lastSaidAt: minutesAgo(50) }), onScreen: target(`b`, { lastSaidAt: minutesAgo(40) }) });
        expect(alternativeOf(routeWake(both), both)).toEqual({ kind: `continue`, id: `a`, why: `thread` });
        const screen = situation({ onScreen: target(`b`, { lastSaidAt: minutesAgo(40) }) });
        expect(alternativeOf(routeWake(screen), screen)).toEqual({ kind: `continue`, id: `b`, why: `screen` });
        expect(alternativeOf(routeWake(situation()), situation())).toBeUndefined();
    });
});

describe(`lastSaidAt`, () => {
    test(`the newest stamp of either side, skipping unstamped rows`, () => {
        expect(lastSaidAt([{ sentAt: 10 }, { openedAt: 30 }, {}])).toBe(30);
        expect(lastSaidAt([{ openedAt: 5 }, {}, {}, {}, {}, {}, {}])).toBe(5);
        expect(lastSaidAt([])).toBeUndefined();
        expect(lastSaidAt([{}, {}])).toBeUndefined();
    });
});
