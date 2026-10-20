import { ASLEEP_WAKE_PATIENCE_MS } from "../../../features/sandbox/diagnosis/diagnose";
import { closeAllWakeWindows, closeWakeWindow, openWakeWindow, WAKE_FAST_RETRY_MS, wakePendingFor } from "./wakeWindow";

afterEach(() => {
    closeAllWakeWindows();
});

describe(`the waking window`, () => {
    it(`lasts as long as the diagnosis waits for a sandbox asleep on its own machine`, () => {
        // Two names for one number, in two layers that cannot import each other (wakeWindow.ts).
        expect(WAKE_FAST_RETRY_MS).toBe(ASLEEP_WAKE_PATIENCE_MS);
        expect(WAKE_FAST_RETRY_MS).toBe(180_000);
    });

    it(`is pending from the ask until WAKE_FAST_RETRY_MS has passed`, () => {
        openWakeWindow(`sb-1`, 1_000);
        expect(wakePendingFor(`sb-1`, 1_000)).toBe(true);
        expect(wakePendingFor(`sb-1`, 1_000 + WAKE_FAST_RETRY_MS - 1)).toBe(true);
        expect(wakePendingFor(`sb-1`, 1_000 + WAKE_FAST_RETRY_MS)).toBe(false);
    });

    it(`is not moved by a later ask in the same wait`, () => {
        // The failure path asks again every minute the sandbox stays away; that must not keep the fast pace up for good.
        openWakeWindow(`sb-1`, 0);
        openWakeWindow(`sb-1`, 60_000);
        expect(wakePendingFor(`sb-1`, WAKE_FAST_RETRY_MS - 1)).toBe(true);
        expect(wakePendingFor(`sb-1`, WAKE_FAST_RETRY_MS)).toBe(false);
    });

    it(`ends when closed, and a later ask opens a fresh one`, () => {
        openWakeWindow(`sb-1`, 0);
        closeWakeWindow(`sb-1`);
        expect(wakePendingFor(`sb-1`, 1)).toBe(false);
        openWakeWindow(`sb-1`, WAKE_FAST_RETRY_MS);
        expect(wakePendingFor(`sb-1`, WAKE_FAST_RETRY_MS + 1)).toBe(true);
    });

    it(`belongs to the sandbox it was asked for`, () => {
        openWakeWindow(`sb-1`, 0);
        expect(wakePendingFor(`sb-2`, 1)).toBe(false);
        expect(wakePendingFor(undefined, 1)).toBe(false);
        closeWakeWindow(`sb-2`);
        expect(wakePendingFor(`sb-1`, 1)).toBe(true);
    });

    it(`closes every window at once when the loop stops`, () => {
        openWakeWindow(`sb-1`, 0);
        openWakeWindow(`sb-2`, 0);
        closeAllWakeWindows();
        expect([wakePendingFor(`sb-1`, 1), wakePendingFor(`sb-2`, 1)]).toEqual([false, false]);
    });
});
