import { WAKE_GAP_MS, watchPageWake } from "./pageWake";

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
