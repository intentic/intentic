import type { CDPSession, Page } from "playwright";
import { type Device, PHONE_BOX, type Phone, phoneFor, putPhoneOn, type Size, takePhoneOff } from "./emulation.js";
import { phoneRegionOf, readGeometry, readRegion, resizeWindow, windowBoundsFor, type Region, type Screen, type WindowBounds, type WindowGeometry } from "./region.js";

/* The window a video view shows (live-view.ts), sized and measured: to the client's box, or to a phone the owner asked
   for (emulation.ts). Kept apart from the view's picture and hands because it is the one part that knows what the page
   reports about its window and when that report is not to be believed: while a phone is on, the page reports the phone.

   A phone sizes the window so its viewport is the fitted device where Chromium allows it (no narrower than about 500 px
   with its toolbar), and the picture is cut to the device either way (region.ts). The client's box is remembered while
   the phone decides, and asked for again when it comes off. The phone follows the view from page to page, and comes off
   when the view stops, with the window put back as it was before it. */

// Chromium applies window bounds asynchronously; the geometry is re-read after this.
const RESIZE_SETTLE_MS = 200;

const settleWindow = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, RESIZE_SETTLE_MS));

// The window a page's session lives in, and where it is; undefined once the page is gone. CDP types every bound as
// optional, and a window always has all four.
const windowOf = async (session: CDPSession): Promise<{ readonly windowId: number; readonly bounds: WindowBounds } | undefined> => {
    // allow(silent-catch): a page gone mid-read has no window to measure; the view's next look asks again.
    const window = await session.send("Browser.getWindowForTarget").catch(() => undefined);
    if (window === undefined) {
        return undefined;
    }
    const { left = 0, top = 0, width = PHONE_BOX.width, height = PHONE_BOX.height } = window.bounds;
    return { windowId: window.windowId, bounds: { left, top, width, height } };
};

// The page the picture follows, with its session.
export interface Shown {
    readonly page: Page;
    readonly session: CDPSession;
}

export interface WindowHost {
    readonly screen: Screen;
    // Undefined between pages: while one is being attached, or once the last has closed.
    readonly shown: () => Shown | undefined;
    // Re-reads where the picture is and restarts it there; `fresh` restarts it even where it did not move, for a picture
    // whose content changed shape under the same rectangle, so the client hears a `ready` either way.
    readonly refit: (fresh?: boolean) => Promise<void>;
}

export interface VideoWindow {
    readonly phone: () => Phone | undefined;
    // Where the picture is now; undefined while that cannot be read (a page mid-navigation), which changes nothing.
    readonly measure: (page: Page) => Promise<Region | undefined>;
    // The client's box: the viewport is made that size, unless a phone decides it.
    readonly resize: (size: Size) => Promise<void>;
    readonly emulate: (asked: Device | undefined) => Promise<void>;
    // The picture is moving off this page's session: the phone comes off the page first, while the session can still
    // send. Then `arrived` puts it on the next page, answering false when there is no phone to put on.
    readonly leaving: (session: CDPSession) => Promise<void>;
    readonly arrived: () => Promise<boolean>;
    // The view is stopping: the phone comes off and the window goes back as it was.
    readonly stop: () => Promise<void>;
}

export const videoWindow = (host: WindowHost): VideoWindow => {
    const { screen } = host;
    // What the page reported about its window when last it reported its own: the chrome's size and the scale.
    let geometry: WindowGeometry | undefined;
    // The phone the owner asked for, while they ask.
    let phone: Phone | undefined;
    // The page wearing it, with the session that dressed it, so it comes off the page it went on.
    let wearer: Shown | undefined;
    // The window as it was before the phone, put back when the phone comes off and no box has been asked for.
    let unphoned: { readonly windowId: number; readonly bounds: WindowBounds } | undefined;
    // The client's last box: obeyed while no phone decides the size, asked again once one stops.
    let box: Size | undefined;
    let stopping = false;

    const measure = async (page: Page): Promise<Region | undefined> => {
        const worn = phone;
        if (worn === undefined) {
            const read = await readRegion(page, screen);
            // Kept only while it still describes the page shown without a phone: a read begun before a phone went on
            // may have caught the phone's report.
            if (read !== undefined && phone === undefined && host.shown()?.page === page) {
                geometry = read.geometry;
            }
            return read?.region;
        }
        const at = host.shown()?.session;
        const base = geometry;
        if (at === undefined || base === undefined) {
            return undefined;
        }
        const window = await windowOf(at);
        return window === undefined ? undefined : phoneRegionOf(window.bounds, base, worn.size, screen);
    };

    const resize = async (size: Size): Promise<void> => {
        if (!Number.isFinite(size.width) || !Number.isFinite(size.height)) {
            return;
        }
        box = { width: size.width, height: size.height };
        const at = host.shown()?.session;
        if (at === undefined || geometry === undefined || phone !== undefined) {
            return;
        }
        // allow(silent-catch): a window gone mid-resize leaves nothing to size; the refit below reads what there is.
        await resizeWindow(at, windowBoundsFor(box, geometry, screen)).catch(() => undefined);
        await settleWindow();
        await host.refit();
    };

    // Takes the phone off the page wearing it, before that page's session goes.
    const undress = async (): Promise<void> => {
        const worn = wearer;
        wearer = undefined;
        // allow(silent-catch): a page that closed while dressed has nothing left to take off.
        await (worn === undefined ? undefined : takePhoneOff(worn.session, worn.page).catch(() => undefined));
    };

    // Puts the phone on the shown page and sizes the window to it.
    const dress = async (): Promise<void> => {
        const shown = host.shown();
        const worn = phone;
        if (shown === undefined || worn === undefined || stopping) {
            return;
        }
        if (wearer?.page !== shown.page) {
            // Read while the page still reports its own window: the chrome's size, which the phone's picture is placed by.
            geometry = (await readGeometry(shown.page)) ?? geometry;
            unphoned ??= await windowOf(shown.session);
        }
        const base = geometry;
        if (base === undefined || host.shown()?.session !== shown.session || phone !== worn || stopping) {
            return;
        }
        try {
            await putPhoneOn(shown.session, worn);
        } catch {
            // allow(silent-catch): a page that closed under the phone is followed by the next one, which is dressed then.
            return;
        }
        wearer = shown;
        // allow(silent-catch): a window gone mid-resize leaves nothing to size; the refit below reads what there is.
        await resizeWindow(shown.session, windowBoundsFor(worn.size, base, screen)).catch(() => undefined);
        await settleWindow();
        await host.refit(true);
    };

    // Takes the phone off and gives the window back its size: the client's last box if it asked for one, else what the
    // window was before. A view that is stopping has no picture left to refit, and puts back the window as it found it.
    const unphone = async (): Promise<void> => {
        phone = undefined;
        await undress();
        const at = host.shown()?.session;
        const before = unphoned;
        unphoned = undefined;
        if (at === undefined) {
            return;
        }
        if (box !== undefined && geometry !== undefined && (!stopping || before === undefined)) {
            // allow(silent-catch): a window gone mid-resize leaves nothing to size.
            await resizeWindow(at, windowBoundsFor(box, geometry, screen)).catch(() => undefined);
            await settleWindow();
        } else if (before !== undefined) {
            // By its own id: a popup the phone followed into is another window, and this one is still the phone's size.
            // allow(silent-catch): a window closed since has nothing to put back.
            await at.send("Browser.setWindowBounds", { windowId: before.windowId, bounds: { ...before.bounds, windowState: "normal" } }).catch(() => undefined);
            await settleWindow();
        }
        if (!stopping) {
            await host.refit(true);
        }
    };

    return {
        phone: () => phone,
        measure,
        resize,
        emulate: async (asked) => {
            if (asked === undefined) {
                if (phone !== undefined) {
                    await unphone();
                }
                return;
            }
            const base = geometry;
            // The box, bounded by what the screen leaves beside the chrome: on a smaller display a phone shrinks further.
            const room =
                base === undefined
                    ? PHONE_BOX
                    : {
                          width: Math.min(PHONE_BOX.width, Math.floor(screen.width / Math.max(1, base.dpr)) - Math.max(0, base.outerWidth - base.innerWidth)),
                          height: Math.min(PHONE_BOX.height, Math.floor(screen.height / Math.max(1, base.dpr)) - Math.max(0, base.outerHeight - base.innerHeight)),
                      };
            phone = phoneFor(asked, room);
            await dress();
        },
        leaving: async (session) => {
            if (wearer?.session === session) {
                await undress();
            }
        },
        arrived: async () => {
            if (phone === undefined) {
                return false;
            }
            await dress();
            return true;
        },
        stop: async () => {
            stopping = true;
            if (phone !== undefined) {
                await unphone();
            }
        },
    };
};
