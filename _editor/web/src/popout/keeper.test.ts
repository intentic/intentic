// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PopoutAnswer } from "./handshake";

/* WHEN A FLOATING WINDOW GETS TO ASK, which is the half of the liveness handshake that no amount of care on the
 * app's side can fix. Everything the window does (uncover the panel, veil it, close itself) hangs off asking
 * its opener whether anyone is still drawing in it, and a window the user is not looking at does not get to run
 * its clock: the browser throttles a hidden window's intervals to one a second, and after a few minutes of that
 * to one a MINUTE.
 *
 * That is the whole of the reported bug. The app gives up waiting for a window in two and a half seconds and
 * puts the panel back in its column; the window, throttled, does not notice for up to a minute, so there is a
 * chat docked on the right and a chat floating on the other screen, and the floating one is a photograph that
 * is not even veiled, because painting the veil is something the tick does too. Worse, the deadline that should
 * have retired it was counted in TICKS: twelve seconds' worth at 200ms each is an hour at one a minute.
 *
 * So both tests below take the window's clock away: setInterval is stubbed out, which is exactly what
 * throttling amounts to from in here, and pin what is left: it still reports in, and it still gives up on time. */

const answers = { current: `live` as PopoutAnswer };

// The opener, from inside the pop-out window: a page that answers the one question, or does not.
const opener = () => (window as unknown as { opener: unknown }).opener as { __intentic: { adoptPopout: ReturnType<typeof vi.fn> } };

const startKeeper = async (panel: string): Promise<ReturnType<typeof vi.fn>> => {
    window.name = panel;
    const adoptPopout = vi.fn(() => answers.current);
    (window as unknown as { opener: unknown }).opener = { closed: false, __intentic: { adoptPopout } };
    vi.resetModules();
    await import(`./keeper`);
    return adoptPopout;
};

// The throttled window, modelled at its worst: the interval never comes round again. Every ask in these tests
// is therefore one the keeper made for a reason OTHER than its clock, which is the whole point of them.
const takeTheClock = (): void => {
    vi.spyOn(globalThis, `setInterval`).mockReturnValue(0 as unknown as ReturnType<typeof setInterval>);
};

// …and for the deadline tests, which need to move time without letting the window notice. Order matters:
// installing the fake timers swaps setInterval wholesale, so the stub goes on after them, not before.
const takeTheClockAndWait = (): void => {
    vi.useFakeTimers();
    takeTheClock();
};

beforeEach(() => {
    answers.current = `live`;
    // jsdom's own close() tears the window down under the test runner, and closing is one of the things being
    // asserted.
    Object.defineProperty(window, `close`, { value: vi.fn(), configurable: true, writable: true });
    takeTheClock();
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe(`the pop-out window's keeper`, () => {
    it(`reports in the moment the app asks, without waiting for a tick it may never get`, async () => {
        const adoptPopout = await startKeeper(`nudged-panel`);
        const asked = adoptPopout.mock.calls.length; // the one it makes on load

        // The app's roll-call: posted when a page loads and goes looking for the window a reload left floating,
        // and whenever what it would answer changes. A broadcast rides the runtime's own queue, so it lands
        // however hard the browser has throttled this window's timers.
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel, not window: this postMessage takes no targetOrigin
        new BroadcastChannel(`intentic.popout`).postMessage({ panel: `nudged-panel` });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(adoptPopout.mock.calls.length).toBeGreaterThan(asked);
        expect(adoptPopout).toHaveBeenLastCalledWith(`nudged-panel`, window);
        expect(window.close).not.toHaveBeenCalled();
    });

    it(`ignores a roll-call for someone else's panel`, async () => {
        const adoptPopout = await startKeeper(`mine-panel`);
        const asked = adoptPopout.mock.calls.length;

        // Two app windows can each have a chat floating, and each obeys only the page that opened it.
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel, not window: this postMessage takes no targetOrigin
        new BroadcastChannel(`intentic.popout`).postMessage({ panel: `yours-panel` });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(adoptPopout.mock.calls.length).toBe(asked);
    });

    it(`gives up after twelve SECONDS of nobody answering, not after sixty ticks of it`, async () => {
        takeTheClockAndWait();
        answers.current = `none`;
        await startKeeper(`orphan-panel`);
        expect(window.close).not.toHaveBeenCalled();

        // Twenty seconds pass with the window's clock taken away, so this is the FIRST ask since the one on
        // load. Counted in ticks it is the second of sixty and the window floats on, dead, for another hour.
        vi.advanceTimersByTime(20_000);
        document.dispatchEvent(new Event(`visibilitychange`));

        expect(window.close).toHaveBeenCalled();
    });

    it(`keeps a window whose app answers, however long it has been between asks`, async () => {
        takeTheClockAndWait();
        answers.current = `waiting`;
        await startKeeper(`patient-panel`);

        // Owned but empty is the hopeful case: an app still booting, a panel host between mounts, and it gets
        // a minute of real time rather than a tick count that throttling turns into an afternoon.
        vi.advanceTimersByTime(20_000);
        document.dispatchEvent(new Event(`visibilitychange`));
        expect(window.close).not.toHaveBeenCalled();

        // …and it is still bounded: a window nothing will ever fill does not float for the rest of the day.
        vi.advanceTimersByTime(61_000);
        document.dispatchEvent(new Event(`visibilitychange`));
        expect(window.close).toHaveBeenCalled();
    });

    it(`veils the panel as soon as it hears there is nothing behind it, and uncovers it when there is`, async () => {
        takeTheClockAndWait();
        answers.current = `live`;
        await startKeeper(`veil-panel`);
        expect(document.querySelector(`[data-intentic-veil]`)).toBeNull();

        answers.current = `waiting`;
        document.dispatchEvent(new Event(`visibilitychange`));
        // An empty window must never read as the app, whatever the app's reason for it being empty.
        expect(document.querySelector(`[data-intentic-veil]`)).not.toBeNull();

        answers.current = `live`;
        document.dispatchEvent(new Event(`visibilitychange`));
        expect(document.querySelector(`[data-intentic-veil]`)).toBeNull();
    });

    it(`closes itself when the page that opened it has gone`, async () => {
        await startKeeper(`orphaned-panel`);
        (opener() as unknown as { closed: boolean }).closed = true;

        document.dispatchEvent(new Event(`visibilitychange`));

        expect(window.close).toHaveBeenCalled();
    });
});
