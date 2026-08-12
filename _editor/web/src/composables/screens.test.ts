// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

/* The desktop's shape, and the two things that make it worth asking for: which monitor is not the one the app
 * is on, and how much room that monitor actually has. A popped-out panel is opened to be read beside the app,
 * and a window opened by a page that can only measure ONE screen either lands back on top of the app or — worse
 * — comes back at the size it had on a bigger monitor, edges hanging off the display it was carried to. */

// A monitor as the browser describes one: the work area (taskbar already subtracted) in the desktop's own
// coordinates, where the primary screen's top-left is the origin.
const monitor = (rect: { left: number; top: number; width: number; height: number }, isPrimary = false) => ({
    availLeft: rect.left,
    availTop: rect.top,
    availWidth: rect.width,
    availHeight: rect.height,
    isPrimary,
    isInternal: isPrimary,
});

// A 2560×1440 primary with a smaller 1920×1080 monitor to its right — the desk this is for, and the size
// difference that turns "reopen where you left it" into a window too wide for the screen it reopens on.
const BIG = monitor({ left: 0, top: 0, width: 2560, height: 1400 }, true);
const SMALL = monitor({ left: 2560, top: 0, width: 1920, height: 1040 });

const attachScreens = (answer: () => Promise<unknown>): void => {
    Object.defineProperty(window, `getScreenDetails`, { value: answer, configurable: true, writable: true });
};

// The API in hand, with the app being read on the first of the given monitors.
const desktop = (...screens: (typeof BIG)[]) => {
    const details = { screens, currentScreen: screens[0] };
    const getScreenDetails = vi.fn(() => Promise.resolve(details));
    attachScreens(getScreenDetails);
    return getScreenDetails;
};

// Module state is per page, and "ask once" is part of what is being tested — so every test gets its own load.
const load = async () => {
    vi.resetModules();
    return import("./screens");
};

afterEach(() => {
    Reflect.deleteProperty(window, `getScreenDetails`);
    Reflect.deleteProperty(navigator, `permissions`);
});

describe(`screens`, () => {
    it(`describes the desktop once the browser has been asked`, async () => {
        const asked = desktop(BIG, SMALL);
        const screens = await load();

        // Nothing is known before the asking: the permission prompt belongs to a gesture, not to page load.
        expect(screens.knownScreens()).toBeUndefined();
        expect(screens.appScreen()).toBeUndefined();

        await screens.learnScreens();

        expect(screens.knownScreens()).toEqual([
            { left: 0, top: 0, width: 2560, height: 1400 },
            { left: 2560, top: 0, width: 1920, height: 1040 },
        ]);
        // The app is on the big one, so "the other screen" — where a popped-out panel goes by default — is the
        // small one beside it.
        expect(screens.appScreen()).toEqual({ left: 0, top: 0, width: 2560, height: 1400 });
        expect(screens.otherScreen()).toEqual({ left: 2560, top: 0, width: 1920, height: 1040 });
        expect(asked).toHaveBeenCalledTimes(1);
    });

    /* "The screen the app is not on" is decided by WHERE a screen is, never by which object the browser handed
     * back. A browser that describes the current screen with a separate object of its own excludes nothing from
     * the list, the app's screen wins by being listed first, and the pop-out opens on top of the app it was torn
     * off — the failure that looks exactly like having no multi-screen support at all. */
    it(`names the other screen even when the browser describes the current one twice`, async () => {
        const details = { screens: [BIG, SMALL], currentScreen: { ...BIG } };
        attachScreens(() => Promise.resolve(details));
        const screens = await load();
        await screens.learnScreens();

        expect(screens.otherScreen()).toEqual({ left: 2560, top: 0, width: 1920, height: 1040 });
    });

    it(`has no other screen to offer on a one-monitor desk`, async () => {
        desktop(BIG);
        const screens = await load();
        await screens.learnScreens();

        expect(screens.otherScreen()).toBeUndefined();
        expect(screens.appScreen()).toEqual({ left: 0, top: 0, width: 2560, height: 1400 });
    });

    /* A prompt the reader dismissed is an answer. Asking again on the next pop-out would turn a gesture they
     * repeat all day into a nag, and the app has a perfectly good fallback — the one screen it can measure. */
    it(`asks once, and keeps working when the answer is no`, async () => {
        const refused = vi.fn(() => Promise.reject(new Error(`NotAllowedError`)));
        attachScreens(refused);
        const screens = await load();

        await screens.learnScreens();
        await screens.learnScreens();

        expect(refused).toHaveBeenCalledTimes(1);
        expect(screens.knownScreens()).toBeUndefined();
        expect(screens.otherScreen()).toBeUndefined();
    });

    // Every browser but Chromium, today. There is nothing to ask, so there is no prompt and no waiting.
    it(`stays quiet in a browser without the API`, async () => {
        const screens = await load();
        await expect(screens.learnScreens()).resolves.toBeUndefined();
        expect(screens.knownScreens()).toBeUndefined();
    });

    /* Granted on an earlier visit, so reading it back costs the reader nothing — and the geometry is in hand
     * before the first pop-out of the session rather than one prompt-shaped beat after it. */
    it(`reads a permission granted earlier without prompting`, async () => {
        desktop(BIG, SMALL);
        Object.defineProperty(navigator, `permissions`, {
            value: { query: vi.fn(() => Promise.resolve({ state: `granted` })) },
            configurable: true,
        });

        const screens = await load();

        await vi.waitFor(() => expect(screens.knownScreens()).toHaveLength(2));
    });

    it(`leaves a permission still to be asked for alone`, async () => {
        const asked = desktop(BIG, SMALL);
        Object.defineProperty(navigator, `permissions`, {
            value: { query: vi.fn(() => Promise.resolve({ state: `prompt` })) },
            configurable: true,
        });

        const screens = await load();
        await Promise.resolve();
        await Promise.resolve();

        expect(asked).not.toHaveBeenCalled();
        expect(screens.knownScreens()).toBeUndefined();
    });
});

describe(`screen geometry`, () => {
    it(`fits a frame to the monitor it lands on`, async () => {
        const { fitInto } = await load();
        const small = { left: 2560, top: 0, width: 1920, height: 1040 };

        // Left the size it had on the big screen, carried to the small one: too wide, too tall, and hanging off
        // the right — the state a reader meets as a window whose own edge they cannot reach.
        expect(fitInto({ left: 3200, top: 100, width: 2200, height: 1300 }, small)).toEqual({
            left: 2560,
            top: 0,
            width: 1920,
            height: 1040,
        });

        // One that already fits is left exactly where it is: fitting is a rescue, not a policy about placement.
        const comfortable = { left: 2700, top: 80, width: 900, height: 800 };
        expect(fitInto(comfortable, small)).toEqual(comfortable);
    });

    it(`centres on a screen, capped by it`, async () => {
        const { centreIn } = await load();
        const small = { left: 2560, top: 0, width: 1920, height: 1040 };

        expect(centreIn(small, { width: 920, height: 840 })).toEqual({ left: 3060, top: 100, width: 920, height: 840 });
        // A panel asking for more than the monitor has gets the monitor.
        expect(centreIn(small, { width: 3000, height: 2000 })).toEqual({ left: 2560, top: 0, width: 1920, height: 1040 });
    });

    it(`names the screen a window is mostly on`, async () => {
        const { screenHolding } = await load();
        const big = { left: 0, top: 0, width: 2560, height: 1400 };
        const small = { left: 2560, top: 0, width: 1920, height: 1040 };

        expect(screenHolding({ left: 2700, top: 100, width: 900, height: 800 }, [big, small])).toEqual(small);
        // Straddling the seam: assigned to whichever monitor holds more of it, the way a window manager decides.
        expect(screenHolding({ left: 2300, top: 100, width: 400, height: 800 }, [big, small])).toEqual(big);
        // The monitor it remembers has been unplugged — nothing there to open a window on.
        expect(screenHolding({ left: 6000, top: 100, width: 900, height: 800 }, [big, small])).toBeUndefined();
        // And a desktop nobody has described: the caller has to place the window some other way.
        expect(screenHolding({ left: 100, top: 100, width: 900, height: 800 }, undefined)).toBeUndefined();
    });
});
