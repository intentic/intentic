import { ref } from "vue";
import { BEAT_MS, refVisibility, WAKE_GAP_MS, watchPageWake } from "../pageWake";

// A PC woken after a night's sleep reads its loopback address once before calls queue on it; everything short of a
// sleep reads nothing.

let visibility: `visible` | `hidden` = `visible`;
Object.defineProperty(document, `visibilityState`, { configurable: true, get: () => visibility });

const setVisibility = (state: `visible` | `hidden`): void => {
    visibility = state;
    document.dispatchEvent(new Event(`visibilitychange`));
};
const pageshow = (persisted: boolean): Event => Object.defineProperty(new Event(`pageshow`), `persisted`, { value: persisted });

const woke = jest.fn<() => void>();
let unwatch: (() => void) | undefined;

beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(1_000_000);
    visibility = `visible`;
    woke.mockReset();
    unwatch = watchPageWake(woke);
});
afterEach(() => {
    unwatch?.();
    jest.useRealTimers();
});

it(`counts a page hidden for a sleep's length as waking, and a glance at another tab as nothing`, () => {
    setVisibility(`hidden`);
    jest.setSystemTime(Date.now() + WAKE_GAP_MS - 1);
    setVisibility(`visible`);
    expect(woke).toHaveBeenCalledTimes(0);

    setVisibility(`hidden`);
    jest.setSystemTime(Date.now() + WAKE_GAP_MS);
    setVisibility(`visible`);
    expect(woke).toHaveBeenCalledTimes(1);
});

it(`counts a machine that slept with the page on screen, told by a beat that ran a sleep late`, () => {
    // Ten minutes awake: every beat on time.
    jest.advanceTimersByTime(10 * 60_000);
    expect(woke).toHaveBeenCalledTimes(0);

    // Asleep: the clock moves and no timer runs until the machine wakes.
    jest.setSystemTime(Date.now() + 2 * WAKE_GAP_MS);
    jest.advanceTimersByTime(15_000);
    expect(woke).toHaveBeenCalledTimes(1);
});

it(`never reads a hidden page's throttled beats as a sleep`, () => {
    setVisibility(`hidden`);
    jest.setSystemTime(Date.now() + 2 * WAKE_GAP_MS);
    jest.advanceTimersByTime(15_000);
    expect(woke).toHaveBeenCalledTimes(0);
});

it(`counts a page the back-forward cache restored as waking, and a fresh page load as nothing`, () => {
    window.dispatchEvent(pageshow(false));
    expect(woke).toHaveBeenCalledTimes(0);
    window.dispatchEvent(pageshow(true));
    expect(woke).toHaveBeenCalledTimes(1);
});

it(`hears nothing once unwatched`, () => {
    unwatch?.();
    unwatch = undefined;
    window.dispatchEvent(pageshow(true));
    jest.setSystemTime(Date.now() + 2 * WAKE_GAP_MS);
    jest.advanceTimersByTime(15_000);
    expect(woke).toHaveBeenCalledTimes(0);
});

describe(`with its own gap and visibility`, () => {
    const shown = ref(true);
    const paneWoke = jest.fn<() => void>();
    const returned = jest.fn<() => void>();
    const PANE_GAP = 5 * 60_000;
    let stop: (() => void) | undefined;

    beforeEach(() => {
        shown.value = true;
        paneWoke.mockReset();
        returned.mockReset();
        stop = watchPageWake(paneWoke, { gapMs: PANE_GAP, visibility: refVisibility(shown), returned });
    });
    afterEach(() => stop?.());

    it(`follows the source it is given, not the document`, () => {
        // A window hidden in the tray: the document still says visible, the source says away.
        shown.value = false;
        jest.setSystemTime(Date.now() + PANE_GAP);
        shown.value = true;
        expect([paneWoke.mock.calls.length, returned.mock.calls.length]).toEqual([1, 0]);
    });

    it(`calls a return short of its gap a return, not a wake, where the document's watcher hears nothing`, () => {
        shown.value = false;
        jest.setSystemTime(Date.now() + WAKE_GAP_MS);
        shown.value = true;
        expect([paneWoke.mock.calls.length, returned.mock.calls.length, woke.mock.calls.length]).toEqual([0, 1, 0]);
    });

    it(`reads the shared beat against its own gap: a two-minute sleep wakes the connection and not the pane`, () => {
        jest.setSystemTime(Date.now() + 2 * WAKE_GAP_MS);
        jest.advanceTimersByTime(BEAT_MS);
        expect([woke.mock.calls.length, paneWoke.mock.calls.length]).toEqual([1, 0]);

        jest.setSystemTime(Date.now() + PANE_GAP);
        jest.advanceTimersByTime(BEAT_MS);
        expect([woke.mock.calls.length, paneWoke.mock.calls.length]).toEqual([2, 1]);
    });

    it(`never counts the sleep it just woke from a second time on the next beat`, () => {
        shown.value = false;
        // Hidden through a long sleep: timers stop, then the page is shown before the first late beat runs.
        jest.setSystemTime(Date.now() + PANE_GAP);
        shown.value = true;
        jest.advanceTimersByTime(BEAT_MS);
        expect(paneWoke).toHaveBeenCalledTimes(1);
    });
});

it(`runs one beat for every watcher in the window`, () => {
    unwatch?.();
    const intervals = jest.spyOn(globalThis, `setInterval`);
    const stops = [watchPageWake(woke), watchPageWake(woke, { gapMs: 5 * 60_000 }), watchPageWake(woke)];
    try {
        expect(intervals).toHaveBeenCalledTimes(1);
    } finally {
        for (const stop of stops) {
            stop();
        }
        intervals.mockRestore();
        unwatch = undefined;
    }
});

