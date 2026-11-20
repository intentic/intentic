import type { BrowserContext, CDPSession, Page } from "playwright";
import type { BrowserViewServerMessage } from "@intentic/sandbox-contract/browser-wire";
import { type CastFraming, castdMediaKey } from "./castd.js";
import { castWindow, type CastWindow } from "./cast-window.js";
import type { Display } from "../cast/display.js";
import { phoneFor, putPhoneOn, takePhoneOff, type Device, type Phone } from "../cast/emulation.js";
import type { LiveView, LiveViewOptions, Sink } from "../cast/live-view.js";
import { mintMediaToken } from "./media-token.js";
import { readRegion } from "../cast/region.js";
import { readSelection, type ScreencastClientMessage } from "../cast/screencast.js";
import { videoWindow, type VideoWindow } from "../cast/video-window.js";
import { askedDevice, isSteer, openTab, steer } from "../cast/view-steering.js";
import { frontTab } from "../state/front-tab.js";

/* A live view whose picture travels on a media socket of its own (castd's), not on this one. The browser view socket
   sends `media {path, token, expiresAt}` and no picture: no ffmpeg, no stills, no xdotool for this window. What drives
   the browser as a program stays here: which tab is in front, addresses and history, new tabs, the selection, and a
   phone. Pointer, keys, clipboard and the box go to castd on the media socket; one sent here is dropped.

   The token is short-lived (castd checks it once, at the upgrade, and a socket outlives it), re-sent before it lapses
   and again whenever castd starts afresh, since a viewer's media socket died with the castd before it. */

// How long a token opens a media socket. Short, since a page that leaked one leaks a minute; long enough that a
// reconnect on a slow link lands inside it.
export const TOKEN_TTL_MS = 60_000;
// A fresh token goes out this long before the last one lapses, so a viewer reconnecting at any moment holds one valid.
const REFRESH_BEFORE_MS = 15_000;
// How often the tab in front is checked, as the video path does.
const FOLLOW_MS = 1_000;

// The `media` message for a castd, with a token minted now under `key` (media-token.ts).
export const mediaMessage = (
    window: { readonly path: string; readonly castd: { readonly session: string } },
    key: Uint8Array,
    readOnly: boolean,
    now: number = Date.now(),
): BrowserViewServerMessage => {
    const expiresAt = now + TOKEN_TTL_MS;
    return { type: "media", path: window.path, token: mintMediaToken(key, { session: window.castd.session, expiresAt, readOnly, issuedAt: now }), expiresAt };
};

// How the picture is cut from the display: a kiosk the daemon launched is the screen (castd sizes it); any other
// window is a rectangle of a larger screen. Read off Chromium, so a window adopted after a restart is told apart too.
const framingOf = async (context: BrowserContext, page: Page | undefined): Promise<"screen" | "crop"> => {
    if (page === undefined) {
        return "crop";
    }
    // allow(silent-catch): a page gone mid-read has no window to read; it is framed the safe way, cut from the screen.
    const session = await context.newCDPSession(page).catch(() => undefined);
    // allow(silent-catch): as above, the page went between the attach and the read.
    const window = await session?.send("Browser.getWindowForTarget").catch(() => undefined);
    // allow(silent-catch): detaching from a page already gone.
    await session?.detach().catch(() => undefined);
    return window?.bounds.windowState === "fullscreen" ? "screen" : "crop";
};

// The page the picture follows, with its session: what a phone is put on, and what a crop is measured off.
interface Shown {
    readonly page: Page;
    readonly session: CDPSession;
}

// The size of the picture as the view drives it. A kiosk's screen: castd sizes it to the viewer, and a phone pins it
// to the device's CSS size, whole and unshrunk, with the device's metrics on the page. A crop: the window is sized and
// measured as on the video path (video-window.ts), and castd's rectangle moved to wherever the viewport is.
interface Framer {
    readonly arrived: (shown: Shown) => Promise<void>;
    readonly leaving: (shown: Shown) => Promise<void>;
    readonly resize: (box: { readonly width: number; readonly height: number }) => Promise<void>;
    readonly emulate: (device: Device | undefined) => Promise<void>;
    readonly follow: () => Promise<void>;
    readonly stop: () => Promise<void>;
}

const screenFramer = (window: CastWindow, shown: () => Shown | undefined): Framer => {
    let phone: Phone | undefined;
    let wearer: Shown | undefined;
    const dress = async (): Promise<void> => {
        const at = shown();
        if (phone === undefined || at === undefined || wearer?.page === at.page) {
            return;
        }
        // allow(silent-catch): a page closed under the phone is followed by the next one, dressed then.
        await putPhoneOn(at.session, phone).catch(() => undefined);
        wearer = at;
    };
    const undress = async (): Promise<void> => {
        const worn = wearer;
        wearer = undefined;
        // allow(silent-catch): a page that closed while dressed has nothing left to take off.
        await (worn === undefined ? undefined : takePhoneOff(worn.session, worn.page).catch(() => undefined));
    };
    return {
        arrived: dress,
        leaving: async (left) => {
            if (wearer?.page === left.page) {
                await undress();
            }
        },
        // The box is castd's, from the media socket.
        resize: async () => undefined,
        emulate: async (device) => {
            await undress();
            phone = device === undefined ? undefined : phoneFor(device, device);
            await window.phone(device === undefined ? undefined : { width: device.width, height: device.height });
            await dress();
        },
        // A window someone took out of fullscreen (Esc held, the menu's "Exit full screen") would show its toolbar in
        // the picture: it is put back, and fitted to the screen again.
        follow: async () => {
            const at = shown();
            // allow(silent-catch): a page gone mid-read has no window to put back; the next tick asks again.
            const target = await at?.session.send("Browser.getWindowForTarget").catch(() => undefined);
            if (at === undefined || target === undefined || target.bounds.windowState === "fullscreen") {
                return;
            }
            // allow(silent-catch): as above, a window closed between the read and the change.
            await at.session.send("Browser.setWindowBounds", { windowId: target.windowId, bounds: { windowState: "fullscreen" } }).catch(() => undefined);
            await window.fit();
        },
        stop: async () => {
            if (phone !== undefined) {
                phone = undefined;
                await undress();
                await window.phone(undefined);
            }
        },
    };
};

const cropFramer = (window: CastWindow, display: Display, shown: () => Shown | undefined): Framer => {
    const move = async (): Promise<void> => {
        const at = shown();
        const region = at === undefined ? undefined : await sizing.measure(at.page);
        if (region !== undefined) {
            await window.castd.moveCrop({ x: region.x, y: region.y, width: region.width, height: region.height });
        }
    };
    const sizing: VideoWindow = videoWindow({ screen: { width: display.width, height: display.height }, shown, refit: move });
    return {
        arrived: async () => {
            if (!(await sizing.arrived())) {
                await move();
            }
        },
        leaving: (left) => sizing.leaving(left.session),
        resize: (box) => sizing.resize(box),
        emulate: (device) => sizing.emulate(device),
        follow: move,
        stop: () => sizing.stop(),
    };
};

// Where a cropped window's picture starts: the front page's viewport where it can be read, else the whole screen until
// the view measures it.
const firstCrop = async (front: Page | undefined, display: Display): Promise<CastFraming> => {
    const read = front === undefined ? undefined : await readRegion(front, { width: display.width, height: display.height });
    const rect = read?.region ?? { x: 0, y: 0, width: display.width, height: display.height };
    return { kind: "crop", rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
};

const startCast = async (context: BrowserContext, key: string, display: Display, front: Page | undefined): Promise<CastWindow | undefined> => {
    const framing: CastFraming = (await framingOf(context, front)) === "screen" ? { kind: "screen" } : await firstCrop(front, display);
    const window = castWindow(key, display, framing);
    return window !== undefined && (await window.ready()) ? window : undefined;
};

// Opens the media path for `context` on `key`'s display, or undefined when castd is not there or will not answer, which
// leaves the window to the video path.
export const startMediaView = async (context: BrowserContext, key: string, display: Display, sink: Sink, options: LiveViewOptions): Promise<LiveView | undefined> => {
    const firstFront = options.front?.page() ?? (await frontTab(context, options.endpoint)) ?? context.pages().at(-1);
    const window = await startCast(context, key, display, firstFront);
    if (window === undefined) {
        return undefined;
    }
    return mediaView(context, window, display, sink, options, firstFront);
};

// The viewer's media tokens: one now, a fresh one before each lapses, and one at once whenever castd starts again,
// since the viewer's media socket went with the last castd.
interface Tokens {
    // A fresh token now.
    readonly send: () => void;
    readonly stop: () => void;
}

const handOut = (window: CastWindow, sink: Sink, readOnly: boolean): Tokens => {
    const key = castdMediaKey();
    let stopped = false;
    const send = (): void => {
        if (!stopped) {
            sink.send(JSON.stringify(mediaMessage(window, key, readOnly)));
        }
    };
    send();
    const refresh = setInterval(send, TOKEN_TTL_MS - REFRESH_BEFORE_MS);
    const unlisten = window.castd.onStarted(send);
    return {
        send,
        stop: () => {
            stopped = true;
            clearInterval(refresh);
            unlisten();
        },
    };
};

const mediaView = (context: BrowserContext, window: CastWindow, display: Display, sink: Sink, options: LiveViewOptions, firstFront: Page | undefined): LiveView => {
    let stopped = false;
    let current: Page | undefined;
    let session: CDPSession | undefined;
    const shown = (): Shown | undefined => (current === undefined || session === undefined ? undefined : { page: current, session });
    const framer = window.castd.framing().kind === "screen" ? screenFramer(window, shown) : cropFramer(window, display, shown);

    const tokens = handOut(window, sink, options.readOnly === true);
    const unwatch = window.watch();

    const attach = async (page: Page): Promise<void> => {
        if (stopped || current === page) {
            return;
        }
        const left = shown();
        current = page;
        session = undefined;
        if (left !== undefined) {
            await framer.leaving(left);
            // allow(silent-catch): detaching from a page already gone.
            await left.session.detach().catch(() => undefined);
        }
        // allow(silent-catch): a page that closed as it was picked has no session; the follow finds the next one.
        const next = await context.newCDPSession(page).catch(() => undefined);
        if (next === undefined || current !== page || stopped) {
            // allow(silent-catch): detaching from a page already gone.
            await next?.detach().catch(() => undefined);
            return;
        }
        session = next;
        await framer.arrived({ page, session: next });
    };

    // The tab Chromium shows, followed as the video path follows it, so the phone and the crop are on the page seen.
    const followFront = async (): Promise<void> => {
        const before = current;
        const fronted = options.front === undefined ? await frontTab(context, options.endpoint) : options.front.page();
        const front = fronted ?? (before === undefined || before.isClosed() ? context.pages().at(-1) : undefined);
        if (front !== undefined && !stopped && current === before) {
            await attach(front);
        }
    };
    const opened = (page: Page): void => void attach(page);
    context.on("page", opened);
    const unwatchFront = options.front?.watch(() => void followFront());
    const ticker = setInterval(() => void followFront().then(() => framer.follow()), FOLLOW_MS);
    void (firstFront === undefined ? followFront() : attach(firstFront));

    return {
        page: () => current,
        bind: async (page) => {
            // Brought in front for real: the picture is the display, and shows only that.
            // allow(silent-catch): a tab closed as it was picked cannot come in front, and the view follows the next.
            await page.bringToFront().catch(() => undefined);
            await attach(page);
        },
        // The media socket pauses castd itself.
        setPaused: async () => undefined,
        input: async (message: ScreencastClientMessage) => {
            if (message.type === "newTab") {
                const page = await openTab(context, message.url);
                if (page !== undefined) {
                    await attach(page);
                }
            } else if (message.type === "emulate") {
                const asked = askedDevice(message);
                if (asked !== "invalid") {
                    await framer.emulate(asked);
                }
            } else if (message.type === "resize") {
                await framer.resize(message);
            } else if (message.type === "media") {
                // The viewer must dial again and its token lapsed: a fresh one now, not at the next refresh.
                tokens.send();
            } else if (isSteer(message)) {
                steer(current, message);
            }
        },
        selection: async () => (current === undefined ? "" : readSelection(current)),
        // Native menus are in castd's picture and its input picks from them.
        chooseOption: async () => undefined,
        stop: async () => {
            stopped = true;
            tokens.stop();
            clearInterval(ticker);
            unwatch();
            unwatchFront?.();
            context.off("page", opened);
            await framer.stop();
            const open = session;
            session = undefined;
            // allow(silent-catch): detaching from a page already gone.
            await open?.detach().catch(() => undefined);
        },
    };
};
