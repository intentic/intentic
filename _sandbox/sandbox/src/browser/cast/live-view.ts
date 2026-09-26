import { errorMessage } from "@intentic/base/errors";
import type { BrowserContext, CDPSession, Page } from "playwright";
import { type Display, displayOf } from "./display.js";
import { readRegion, regionsEqual, resizeWindow, windowBoundsFor, type Region, type Screen, type WindowGeometry } from "./region.js";
import {
    applySelect,
    cursorReporter,
    dispatchInput,
    encodeFrame,
    readSelect,
    readSelection,
    startScreencast,
    STILL_QUALITY,
    STILL_SCALE,
    VIEW_HEIGHT,
    VIEW_WIDTH,
    type MouseMessage,
    type Screencast,
    type ScreencastClientMessage,
} from "./screencast.js";
import { createStillTaker } from "./stills.js";
import { encodeVideo, startVideocast, type Videocast, type VideoFrame } from "./videocast.js";
import { startXInput, type XInput } from "./xinput.js";

// One live browser over one socket; the choice of video vs frames is made once here, not per route. Video grabs the
// page's viewport off its X display (region.ts): cheaper than frames and showing everything Chromium draws there, a
// native <select>, a context menu, a popup window; frames photographs the page's compositor, for a browser with no
// display. Which one runs is a fact of launch, not a setting.
//
// The chrome is the client's (tabs, address bar, navigation), fed by the session and steered by the messages below;
// the picture carries the page alone.

// Socket-shaped, so this module never imports hono. Both routes hand it their `ws`. `backlog` is what the socket holds
// unsent, the one number that says a viewer's link is slower than the picture.
export interface Sink {
    readonly send: (data: string | Uint8Array<ArrayBuffer>) => void;
    readonly backlog?: () => number;
}

export interface LiveView {
    // What the picture is of, for clipboard/address; undefined before the first page or after the last closes.
    readonly page: () => Page | undefined;
    readonly bind: (page: Page) => Promise<void>;
    readonly setPaused: (paused: boolean) => Promise<void>;
    // Pointer, keystroke, navigation or resize; answers with whatever the surface owes after: a drop-down on frames,
    // nothing on video.
    readonly input: (message: ScreencastClientMessage) => Promise<void>;
    readonly selection: () => Promise<string>;
    readonly chooseOption: (index: number) => Promise<void>;
    readonly stop: () => Promise<void>;
}

// One message telling the client what it's looking at: `kind` picks the decoder, geometry defines pointer coordinates.
// Both kinds are the page alone now; video is at the display's device pixels, `scale` of them per CSS pixel.
export interface LiveReady {
    readonly type: "ready";
    readonly kind: "video" | "frames";
    readonly width: number;
    readonly height: number;
    readonly scale: number;
    // Only on the video path, read out of the stream rather than written down.
    readonly codec?: string;
}

// Unsent bytes a viewer's socket may hold before frames are dropped until the next keyframe; a second of video at the
// encoder's ceiling, so a link that keeps up never sees it.
const BACKLOG_LIMIT = 256 * 1024;
// How often the shown page is checked for having gone behind another tab or changed shape; the picture itself is the
// display, so only the cursor, keys and stills are ever this late.
const FOLLOW_MS = 1000;
// Chromium applies window bounds asynchronously; the geometry is re-read after this.
const RESIZE_SETTLE_MS = 200;

type Steer = Extract<ScreencastClientMessage, { type: "navigate" | "back" | "forward" | "reload" | "stop" }>;

const STEERS: ReadonlySet<string> = new Set<Steer["type"]>(["navigate", "back", "forward", "reload", "stop"]);
const isSteer = (message: ScreencastClientMessage): message is Steer => STEERS.has(message.type);

// A tab the owner asked for, at the address they typed if any; undefined when the browser is gone.
const openTab = async (context: BrowserContext, url: string | undefined): Promise<Page | undefined> => {
    const page = await context.newPage().catch(() => undefined);
    if (page !== undefined && url !== undefined) {
        steer(page, { type: "navigate", url });
    }
    return page;
};

// Not awaited past the commit and never past an error: Chromium shows its own error page for a bad address, and a
// slow site must not hold the socket's handler.
const steer = (page: Page | undefined, message: Steer): void => {
    if (page === undefined) {
        return;
    }
    const swallow = (): undefined => undefined;
    switch (message.type) {
        case "navigate":
            void page.goto(message.url, { waitUntil: "commit" }).catch(swallow);
            return;
        case "back":
            void page.goBack({ waitUntil: "commit" }).catch(swallow);
            return;
        case "forward":
            void page.goForward({ waitUntil: "commit" }).catch(swallow);
            return;
        case "reload":
            void page.reload({ waitUntil: "commit" }).catch(swallow);
            return;
        case "stop":
            void page.evaluate(() => window.stop()).catch(swallow);
            return;
        default:
            return;
    }
};

// Whether the page has a single <select> focused: its menu is native, and only a keystroke on the display reaches it,
// so the keyboard goes by XTEST while this holds. Walks frames like readSelect, since controls often live in one.
const selectFocusedIn = async (page: Page): Promise<boolean> => {
    for (const frame of page.frames()) {
        const focused = await frame
            .evaluate(() => document.activeElement instanceof HTMLSelectElement && !document.activeElement.multiple)
            .catch(() => false);
        if (focused) {
            return true;
        }
    }
    return false;
};

// The tab in front: the page whose document is visible. Pages in different windows are all visible, and the newest
// window is the one on top of a display with no window manager.
const foregroundOf = async (context: BrowserContext): Promise<Page | undefined> => {
    const open = context.pages();
    const visible = await Promise.all(open.map((page) => page.evaluate(() => document.visibilityState === "visible").catch(() => false)));
    return open.findLast((_, index) => visible[index] === true) ?? open.at(-1);
};

const startVideoView = (context: BrowserContext, display: Display, sink: Sink, onError: (reason: string) => void): LiveView => {
    const input: XInput = startXInput(display);
    const screen: Screen = { width: display.width, height: display.height };
    let paused = false;
    let stopped = false;
    // The page the cursor, keys and stills address; the picture is whatever Chromium has in front, which this follows.
    let current: Page | undefined;
    let session: CDPSession | undefined;
    let region: Region | undefined;
    let geometry: WindowGeometry | undefined;
    let cast: Videocast | undefined;
    // Frames are being dropped until a keyframe finds the socket drained; see BACKLOG_LIMIT.
    let dropping = false;
    let selectFocused = false;
    const reportCursor = cursorReporter((cursor) => sink.send(JSON.stringify({ type: "cursor", cursor })));

    const stills = createStillTaker({
        // The viewport at 2 CSS px per pixel whatever the display's own scale, clipped in document coordinates as CDP
        // wants them.
        capture: async () => {
            const at = session;
            const from = region;
            if (at === undefined || from === undefined) {
                return undefined;
            }
            const { cssVisualViewport: viewport } = await at.send("Page.getLayoutMetrics");
            const shot = await at.send("Page.captureScreenshot", {
                format: "webp",
                quality: STILL_QUALITY,
                clip: { x: viewport.pageX, y: viewport.pageY, width: viewport.clientWidth, height: viewport.clientHeight, scale: STILL_SCALE / from.scale },
            });
            return shot.data;
        },
        send: (bytes) => sink.send(encodeFrame({ bytes, format: "webp" })),
    });

    // Every frame is judged for motion, then either sent or dropped: a socket holding more than a second of video is
    // slower than the picture, and sending on would only put the pointer further ahead of what the owner sees.
    const deliver = (frame: VideoFrame): void => {
        const quiet = stills.noteFrame({ key: frame.key, bytes: frame.bytes.byteLength }) === "quiet";
        const backlog = sink.backlog?.() ?? 0;
        if (dropping) {
            if (!frame.key || backlog > BACKLOG_LIMIT) {
                return;
            }
            dropping = false;
        } else if (backlog > BACKLOG_LIMIT) {
            dropping = true;
            return;
        }
        sink.send(encodeVideo(frame, quiet));
    };

    // (Re)starts the grab on the current region; every start is a fresh stream, announced to the client by its own
    // `ready`, so a resize or a window change costs one keyframe and nothing else.
    const run = (): void => {
        const at = region;
        if (at === undefined || paused || stopped) {
            return;
        }
        cast?.stop();
        dropping = false;
        cast = startVideocast(display, at, {
            onFrame: deliver,
            onCodec: (codec) =>
                sink.send(JSON.stringify({ type: "ready", kind: "video", width: at.width, height: at.height, scale: at.scale, codec } satisfies LiveReady)),
            onExit: (reason) => {
                if (!paused && !stopped) {
                    onError(reason);
                }
            },
        });
        stills.reset();
    };

    // Re-reads where the shown page's viewport is; a change (a resize, fullscreen, a popup's own chrome) restarts the
    // grab there. Nothing changes while the read fails, since a page mid-navigation still occupies the same window.
    const refit = async (): Promise<void> => {
        const page = current;
        if (page === undefined || stopped) {
            return;
        }
        const read = await readRegion(page, screen);
        if (read === undefined || current !== page) {
            return;
        }
        geometry = read.geometry;
        if (region !== undefined && regionsEqual(region, read.region)) {
            return;
        }
        region = read.region;
        run();
    };

    const attach = async (page: Page): Promise<void> => {
        if (stopped || current === page) {
            return;
        }
        current = page;
        selectFocused = false;
        const previous = session;
        session = undefined;
        await previous?.detach().catch(() => undefined);
        const next = await context.newCDPSession(page).catch(() => undefined);
        if (next === undefined) {
            return;
        }
        if (current !== page || stopped) {
            await next.detach().catch(() => undefined);
            return;
        }
        session = next;
        // The previous page's still says nothing about this one; the same region keeps its stream.
        stills.reset();
        await refit();
    };

    const followFront = async (): Promise<void> => {
        const before = current;
        const front = await foregroundOf(context);
        // A page attached while this was asking (a tab just opened) is newer than the answer, which was read off the
        // pages that existed before it; the next tick asks again.
        if (front === undefined || stopped || current !== before) {
            return;
        }
        await attach(front);
    };

    const watchClose = (page: Page): void => {
        page.on("close", () => {
            if (current === page && !stopped) {
                current = undefined;
                void followFront();
            }
        });
    };
    // A page Chromium just opened is the one in front, tab and popup alike.
    const follow = (page: Page): void => {
        watchClose(page);
        void attach(page);
    };
    context.on("page", follow);
    for (const page of context.pages()) {
        watchClose(page);
    }
    void followFront();

    const ticker = setInterval(() => {
        if (paused || stopped) {
            return;
        }
        void followFront().then(refit);
    }, FOLLOW_MS);

    const probeSelect = (): void => {
        const page = current;
        if (page === undefined) {
            return;
        }
        void selectFocusedIn(page).then((focused) => {
            if (current === page) {
                selectFocused = focused;
            }
        });
    };

    // Sizes the window so the viewport is what the client's box holds, then re-reads where that put the viewport.
    const resize = async (size: { readonly width: number; readonly height: number }): Promise<void> => {
        const at = session;
        if (at === undefined || geometry === undefined || !Number.isFinite(size.width) || !Number.isFinite(size.height)) {
            return;
        }
        await resizeWindow(at, windowBoundsFor(size, geometry, screen)).catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, RESIZE_SETTLE_MS));
        await refit();
    };

    const mouse = (message: MouseMessage): void => {
        const at = region;
        if (at === undefined) {
            return;
        }
        stills.noteInput();
        pointer(input, message, at);
        if (message.action === "move" && session !== undefined) {
            // Fire-and-forget and throttled, so the cursor shape never blocks the next input; the page is asked in its
            // own CSS pixels.
            reportCursor(session, message.x / at.scale, message.y / at.scale);
        } else if (message.action === "up") {
            probeSelect();
        }
    };

    const keys = async (message: Extract<ScreencastClientMessage, { type: "text" | "key" }>): Promise<void> => {
        stills.noteInput();
        // On the display when asked (Chromium's find bar) or when a native menu has the keyboard; on the page otherwise,
        // where a CDP key event lands whatever the browser itself has focused and arrives as exact text.
        if (message.raw === true || selectFocused) {
            if (message.type === "text") {
                input.type(message.text);
            } else {
                input.key(chordOf(message));
            }
        } else if (session !== undefined) {
            await dispatchInput(session, message).catch((error: unknown) => onError(errorMessage(error)));
        }
        if (message.type === "key") {
            // Tab and Escape move focus into and out of controls; the next keystroke must know where it is.
            probeSelect();
        }
    };

    return {
        page: () => current,
        bind: async (page) => {
            // The owner picked a tab: brought in front for real, since the picture is the display and shows only that.
            await page.bringToFront().catch(() => undefined);
            await attach(page);
        },
        setPaused: async (next) => {
            if (paused === next) {
                return;
            }
            paused = next;
            // Pausing kills the encoder, since an idle one still costs a core; resuming starts fresh with a keyframe.
            stills.setPaused(next);
            if (next) {
                cast?.stop();
                cast = undefined;
            } else {
                run();
            }
        },
        input: async (message) => {
            if (message.type === "mouse") {
                mouse(message);
            } else if (message.type === "text" || message.type === "key") {
                await keys(message);
            } else if (message.type === "resize") {
                await resize(message);
            } else if (message.type === "newTab") {
                const page = await openTab(context, message.url);
                if (page !== undefined) {
                    await attach(page);
                }
            } else if (isSteer(message)) {
                steer(current, message);
            }
        },
        selection: async () => (current === undefined ? "" : readSelection(current)),
        // The native menu is in the picture and XTEST clicks it, so nothing ever asks for this here.
        chooseOption: async () => {},
        stop: async () => {
            stopped = true;
            clearInterval(ticker);
            context.off("page", follow);
            cast?.stop();
            cast = undefined;
            stills.stop();
            input.stop();
            const open = session;
            session = undefined;
            await open?.detach().catch(() => undefined);
        },
    };
};

// Both coordinates finite, or the event names no point on the display: a client that cannot measure its picture
// sends null, and `Math.round(null)` is 0, which replays as a real click in the top-left corner.
const aimed = (message: MouseMessage): boolean => Number.isFinite(message.x) && Number.isFinite(message.y);

// A pointer event, in the picture's own coordinates, moved to the display's by the region's origin: the space the grab
// and XTEST share.
const pointer = (input: XInput, message: MouseMessage, region: Region): void => {
    if (!aimed(message)) {
        return;
    }
    const x = message.x + region.x;
    const y = message.y + region.y;
    if (message.action === "wheel") {
        input.wheel(x, y, message.deltaX ?? 0, message.deltaY ?? 0);
        return;
    }
    if (message.action === "move") {
        input.move(x, y);
        return;
    }
    // Double click is replayed as two clicks, since X has no clickCount field, same as a real mouse.
    const repeat = message.action === "down" ? Math.min(3, Math.max(1, message.clickCount ?? 1)) : 1;
    for (let index = 0; index < repeat; index++) {
        if (message.action === "down") {
            input.down(x, y, message.button);
        } else {
            input.up(x, y, message.button);
        }
    }
};

// Modifiers join a keysym with plus signs (xdotool syntax); names mostly match the DOM's, letters pass through.
const XKEYS: Record<string, string> = { Enter: "Return", Backspace: "BackSpace", Delete: "Delete", Escape: "Escape", Tab: "Tab", " ": "space" };

export const chordOf = (message: { readonly key: string; readonly ctrl?: boolean; readonly shift?: boolean; readonly alt?: boolean }): string => {
    const held = [message.ctrl === true ? "ctrl" : undefined, message.alt === true ? "alt" : undefined, message.shift === true ? "shift" : undefined];
    return [...held.filter((name) => name !== undefined), XKEYS[message.key] ?? message.key].join("+");
};

const startFramesView = async (context: BrowserContext, sink: Sink, onError: (reason: string) => void): Promise<LiveView> => {
    const cast: Screencast = await startScreencast(context, (frame) => sink.send(encodeFrame(frame)));
    // Cursor shape is asked for here, since a compositor surface has none; reported as it changes.
    const reportCursor = cursorReporter((cursor) => sink.send(JSON.stringify({ type: "cursor", cursor })));
    sink.send(JSON.stringify({ type: "ready", kind: "frames", width: VIEW_WIDTH, height: VIEW_HEIGHT, scale: 1 } satisfies LiveReady));
    // A pointer or keystroke to the page's CDP session, and what the surface owes after it.
    const dispatch = async (message: ScreencastClientMessage): Promise<void> => {
        const session = cast.attached();
        if (session === undefined) {
            return;
        }
        // Told before the dispatch, or the answering frame reads as a camera shake and gets dropped.
        cast.noteInput();
        await dispatchInput(session, message).catch((error: unknown) => onError(errorMessage(error)));
        if (message.type !== "mouse") {
            return;
        }
        if (message.action === "move") {
            // Fire-and-forget and throttled, so the cursor shape never blocks the next input.
            reportCursor(session, message.x, message.y);
        } else if (message.action === "up") {
            // A click may open a drop-down no frame shows, since Chromium draws it outside the page.
            const page = cast.page();
            // allow(silent-catch): a page that closed under the click has no drop-down to show, so none is sent.
            const menu = page === undefined ? undefined : await readSelect(page).catch(() => undefined);
            sink.send(JSON.stringify({ type: "select", menu: menu ?? null }));
        }
    };
    return {
        page: () => cast.page(),
        bind: (page: Page) => cast.bind(page, true),
        setPaused: (paused: boolean) => cast.setPaused(paused),
        input: async (message: ScreencastClientMessage) => {
            if (message.type === "newTab") {
                await openTab(context, message.url);
            } else if (isSteer(message)) {
                steer(cast.page(), message);
            } else if (message.type !== "resize") {
                // A compositor surface is photographed at its fixed size, so a resize is nothing here.
                await dispatch(message);
            }
        },
        selection: async () => {
            const page = cast.page();
            return page === undefined ? "" : readSelection(page);
        },
        chooseOption: async (index: number) => {
            const page = cast.page();
            if (page !== undefined) {
                await applySelect(page, index);
            }
        },
        stop: () => cast.stop(),
    };
};

// Shows `context` on `sink`, the best way its browser allows. `key` names the display it was allocated under; this only
// asks whether one exists, since starting one now would put it on a display the browser isn't.
export const startLiveView = async (context: BrowserContext, key: string, sink: Sink, onError: (reason: string) => void): Promise<LiveView> => {
    const display = displayOf(key);
    return display === undefined ? startFramesView(context, sink, onError) : startVideoView(context, display, sink, onError);
};
