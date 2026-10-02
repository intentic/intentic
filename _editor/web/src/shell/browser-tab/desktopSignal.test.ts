import "@intentic/testing/dom";
import { BURST, type NoticeChoice, type NoticeSubject, noticesFor, settledAsks } from "./desktopSignal";
import type { NewsItems, TabFrame } from "./tabSignal";

// The tab's news as the desktop app's notifications: one per caller and per finished turn, a burst counted in one, the
// system's sound once, and none at all where a chime rings for it.

const subject = (title: string, over: Partial<NoticeSubject> = {}): NoticeSubject => ({ title, line: `Needs you · Question`, path: `/?conversation=${title}`, ...over });

// The fleet as the describers read it: every caller and every finished turn named after its key.
const fleetNames = {
    ask: (source: string, key: string): NoticeSubject | undefined => (key === `gone` ? undefined : subject(key, { path: `/?sandbox=${source}&conversation=${key}` })),
    finish: (key: string): NoticeSubject | undefined => subject(key, { line: `Turn finished` }),
};

const all: NoticeChoice = { asks: true, finished: true, chimed: false, sound: true };

const asked = (...keys: string[]): NewsItems[`asked`] => keys.map((key) => ({ source: `sbx`, key }));

describe(`the notifications for a reading's news`, () => {
    it(`is one per caller and per finished turn, what needs the reader first, and only the first makes a sound`, () => {
        const notices = noticesFor({ asked: asked(`a`), finished: [`sbx/b`] }, fleetNames, all);
        expect(notices).toEqual([
            { key: `asks:sbx/a`, kind: `asks`, title: `a`, body: `Needs you · Question`, path: `/?sandbox=sbx&conversation=a`, silent: false },
            { key: `finished:sbx/b`, kind: `finished`, title: `sbx/b`, body: `Turn finished`, path: `/?conversation=sbx/b`, silent: true },
        ]);
    });

    it(`counts a burst in one notification, naming what it counts`, () => {
        const keys = Array.from({ length: BURST + 1 }, (_, index) => `agent${index}`);
        expect(noticesFor({ asked: asked(...keys), finished: [] }, fleetNames, all)).toEqual([
            { key: `asks:many`, kind: `asks`, title: `4 agents need you`, body: `agent0 · agent1 · agent2 · agent3`, path: `/agents`, silent: false },
        ]);
        const finished = noticesFor({ asked: [], finished: keys.map((key) => `sbx/${key}`) }, fleetNames, all);
        expect(finished.map((notice) => [notice.key, notice.title])).toEqual([[`finished:many`, `4 turns finished`]]);
    });

    it(`tells up to a burst one by one`, () => {
        const keys = Array.from({ length: BURST }, (_, index) => `agent${index}`);
        expect(noticesFor({ asked: asked(...keys), finished: [] }, fleetNames, all).map((notice) => notice.key)).toEqual([
            `asks:sbx/agent0`,
            `asks:sbx/agent1`,
            `asks:sbx/agent2`,
        ]);
    });

    it(`makes no sound where a chime rings for it, or inside the gap since the last one`, () => {
        const items = { asked: asked(`a`), finished: [] };
        expect(noticesFor(items, fleetNames, { ...all, chimed: true }).map((notice) => notice.silent)).toEqual([true]);
        expect(noticesFor(items, fleetNames, { ...all, sound: false }).map((notice) => notice.silent)).toEqual([true]);
    });

    it(`says nothing of a kind the reader turned off, nor of what it cannot name`, () => {
        const items = { asked: asked(`a`, `gone`), finished: [`sbx/b`] };
        expect(noticesFor(items, fleetNames, { ...all, asks: false }).map((notice) => notice.key)).toEqual([`finished:sbx/b`]);
        expect(noticesFor(items, fleetNames, { ...all, finished: false }).map((notice) => notice.key)).toEqual([`asks:sbx/a`]);
        // The first that makes it up is the one with the sound, whichever kind it is.
        expect(noticesFor(items, fleetNames, { ...all, asks: false })[0]?.silent).toBe(false);
    });

    it(`names the sandbox when it is not the one in front of the reader`, () => {
        const elsewhere = { ask: (): NoticeSubject => subject(`a`, { elsewhere: `Work box` }), finish: fleetNames.finish };
        expect(noticesFor({ asked: asked(`a`), finished: [] }, elsewhere, all)[0]?.body).toBe(`Needs you · Question · in Work box`);
    });
});

const frame = (asks: Record<string, readonly string[]>): TabFrame => ({
    asks: new Map(Object.entries(asks).map(([source, keys]) => [source, new Set(keys)] as const)),
    working: new Set(),
    settled: new Set(),
});

describe(`the asks to take down`, () => {
    it(`are those the reading no longer holds, in a source it still reads`, () => {
        const posted = new Set([`asks:sbx/a`, `asks:sbx/b`, `asks:sbx#held/w1`, `finished:sbx/c`, `asks:gone/x`]);
        expect(settledAsks(posted, frame({ sbx: [`b`], [`sbx#held`]: [] }))).toEqual([`asks:sbx/a`, `asks:sbx#held/w1`]);
    });

    it(`are none while every caller still calls`, () => {
        expect(settledAsks(new Set([`asks:sbx/a`]), frame({ sbx: [`a`] }))).toEqual([]);
    });
});
