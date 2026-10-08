import { errorMessage } from "@intentic/base/errors";
import type { BrowserContext, CDPSession, Page } from "playwright";
import { type Display, displayOf } from "./display.js";
import { type Device, EmulateMessageSchema, PHONE_BOX, type Phone, phoneFor, putPhoneOn, takePhoneOff } from "./emulation.js";
import { frontTab } from "./front-tab.js";
import { regionsEqual, type Region, type Screen } from "./region.js";
import {
    applySelect,
    cursorReporter,
    dispatchInput,
    encodeFrame,
    readSelect,
    readSelection,
    startScreencast,
    STILL_QUALITY,
    type MouseMessage,
    type Screencast,
    type ScreencastClientMessage,
} from "./screencast.js";
import { createStillTaker } from "./stills.js";
import { videoWindow } from "./video-window.js";
import { encodeVideo, grabStill, startVideocast, type Videocast, type VideoFrame } from "./videocast.js";
import { startXInput, type XInput } from "./xinput.js";

// One live browser over one socket; the choice of video vs frames is made once here, not per route. Video grabs the
// page's viewport off its X display (region.ts): cheaper than frames and showing everything Chromium draws there, a
// native <select>, a context menu, a popup window; frames photographs the page's compositor, for a browser with no
// display. Which one runs is a fact of launch, not a setting.
//
// The chrome is the client's (tabs, address bar, navigation), fed by the session and steered by the messages below;
// the picture carries the page alone.
//
// Or a phone (emulation.ts), on either path: the picture is then the device's screen alone, shrunk to fit VIEW_WIDTH ×
// VIEW_HEIGHT, announced by a fresh `ready` of that size, and a pointer event in the picture's pixels still lands on what
// it was aimed at (Chromium maps input through the same scale it draws with). The client's box is ignored while the
// device decides the size, and asked again when the phone comes off. Taken off when the view stops, whatever the
// client did.

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

// The device an emulate asks for, undefined to take it off, or "invalid" for a frame of any other shape, which is dropped.
const askedDevice = (message: ScreencastClientMessage): Device | undefined | "invalid" => {
    const parsed = EmulateMessageSchema.safeParse(message);
    return parsed.success ? parsed.data.device : "invalid";
};

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

const startVideoView = (context: BrowserContext, display: Display, sink: Sink, onError: (reason: string) => void, endpoint: string | undefined): LiveView => {
    const input: XInput = startXInput(display);
    const screen: Screen = { width: display.width, height: display.height };
    let paused = false;
    let stopped = false;
    // The page the cursor, keys and stills address; the picture is whatever Chromium has in front, which this follows.
    let current: Page | undefined;
    let session: CDPSession | undefined;
    let region: Region | undefined;
    let cast: Videocast | undefined;
    // Frames are being dropped until a keyframe finds the socket drained; see BACKLOG_LIMIT.
    let dropping = false;
    let selectFocused = false;
    const reportCursor = cursorReporter((cursor) => sink.send(JSON.stringify({ type: "cursor", cursor })));

    const stills = createStillTaker({
        // The rectangle the video grabs, off the same display at its own pixels: what the picture shows, Chromium's
        // bubbles and menus over the page included, a phone's screen too. A photograph of the page (CDP) left those
        // out, so the picture blinked between them, and re-rendered the live window while it was taken.
        capture: async () => {
            const at = region;
            if (at === undefined) {
                return undefined;
            }
            return (await grabStill(display, at, STILL_QUALITY))?.toString("base64");
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
    // `fresh` restarts it even unchanged (video-window.ts).
    const refit = async (fresh = false): Promise<void> => {
        const page = current;
        if (page === undefined || stopped) {
            return;
        }
        const worn = sizing.phone();
        const next = await sizing.measure(page);
        // A read begun before a phone went on or came off describes the other picture.
        if (next === undefined || current !== page || sizing.phone() !== worn) {
            return;
        }
        if (!fresh && region !== undefined && regionsEqual(region, next)) {
            return;
        }
        region = next;
        run();
    };

    // The window's size and the phone, if the owner asked for one.
    const sizing = videoWindow({ screen, shown: () => (current === undefined || session === undefined ? undefined : { page: current, session }), refit });

    const attach = async (page: Page): Promise<void> => {
        if (stopped || current === page) {
            return;
        }
        current = page;
        selectFocused = false;
        const previous = session;
        session = undefined;
        // The phone follows the view: off the page it leaves, onto the one it shows next.
        if (previous !== undefined) {
            await sizing.leaving(previous);
        }
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
        if (!(await sizing.arrived())) {
            await refit();
        }
    };

    // The tab Chromium shows, followed when the picture addresses another: an agent switching tabs, a tab closing. Where
    // that cannot be read (front-tab.ts), the view keeps the page it addresses, and only one that closed is replaced,
    // by the newest still open.
    const followFront = async (): Promise<void> => {
        const before = current;
        const front = (await frontTab(context, endpoint)) ?? (before === undefined || before.isClosed() ? context.pages().at(-1) : undefined);
        // A page attached while this was asking (a tab just opened, a tab the owner picked) is newer than the answer,
        // which was read before it; the next tick asks again.
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
        void followFront().then(() => refit());
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

    const mouse = (message: MouseMessage): void => {
        const at = region;
        if (at === undefined) {
            return;
        }
        // A bare pointer move answers with hover at most; a click, a drag or a wheel can answer with a change too small
        // to read as motion (a ticked box, a selection), so the still is withdrawn before the page sees it.
        if (message.action === "move" && (message.buttons ?? 0) === 0) {
            stills.noteInput();
        } else {
            stills.noteAction();
        }
        pointer(input, message, at);
        if (message.action === "move" && session !== undefined) {
            // Fire-and-forget and throttled, so the cursor shape never blocks the next input; the page is asked in its
            // own CSS pixels, a phone's shrinking undone.
            const shrunk = at.scale * (sizing.phone()?.fit ?? 1);
            reportCursor(session, message.x / shrunk, message.y / shrunk);
        } else if (message.action === "up") {
            probeSelect();
        }
    };

    const keys = async (message: Extract<ScreencastClientMessage, { type: "text" | "key" }>): Promise<void> => {
        // A typed character is a few hundred bytes of video, far below motion: without this it stays under the still.
        stills.noteAction();
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
                // The window is sized to the client's box, then the picture refits to it; a phone defers the box.
                await sizing.resize(message);
            } else if (message.type === "emulate") {
                const asked = askedDevice(message);
                if (asked !== "invalid") {
                    await sizing.emulate(asked);
                }
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
            // The phone was this socket's, not the browser's: the agent's own next use finds the page as it was.
            await sizing.stop();
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
    // The phone the owner asked for, while they ask: put on every page the screencast binds, taken off every page it
    // lets go. CDP input is in the picture's pixels whatever the scale, so only the page-side reads below are rescaled.
    let phone: Phone | undefined;
    const cast: Screencast = await startScreencast(context, (frame) => sink.send(encodeFrame(frame)), {
        bound: async (session) => {
            if (phone !== undefined) {
                await putPhoneOn(session, phone);
            }
        },
        unbinding: async (session, page) => {
            if (phone !== undefined) {
                await takePhoneOff(session, page);
            }
        },
        sharp: () => phone === undefined,
    });
    // Cursor shape is asked for here, since a compositor surface has none; reported as it changes.
    const reportCursor = cursorReporter((cursor) => sink.send(JSON.stringify({ type: "cursor", cursor })));
    // The picture's size: the fixed viewport (VIEW_WIDTH × VIEW_HEIGHT), or the fitted phone, which is exactly what
    // Chromium's frames of it measure.
    const announce = (): void => {
        const size = phone?.size ?? PHONE_BOX;
        sink.send(JSON.stringify({ type: "ready", kind: "frames", width: size.width, height: size.height, scale: 1 } satisfies LiveReady));
    };
    announce();
    const emulate = async (asked: Device | undefined): Promise<void> => {
        const session = cast.attached();
        const page = cast.page();
        if (asked === undefined) {
            if (phone === undefined) {
                return;
            }
            phone = undefined;
            // allow(silent-catch): a page that closed while dressed has nothing left to take off.
            await (session === undefined || page === undefined ? undefined : takePhoneOff(session, page).catch(() => undefined));
        } else {
            phone = phoneFor(asked, PHONE_BOX);
            // allow(silent-catch): a page that closed under the phone is followed by the next one, which is dressed then.
            await (session === undefined ? undefined : putPhoneOn(session, phone).catch(() => undefined));
        }
        announce();
    };
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
        const fit = phone?.fit ?? 1;
        if (message.action === "move") {
            // Fire-and-forget and throttled, so the cursor shape never blocks the next input; asked in the page's own
            // CSS pixels, a phone's shrinking undone.
            reportCursor(session, message.x / fit, message.y / fit);
        } else if (message.action === "up") {
            // A click may open a drop-down no frame shows, since Chromium draws it outside the page.
            const page = cast.page();
            // allow(silent-catch): a page that closed under the click has no drop-down to show, so none is sent.
            const menu = page === undefined ? undefined : await readSelect(page).catch(() => undefined);
            // Anchored in the picture's pixels, which a phone shrinks from the page's.
            const placed =
                menu === undefined
                    ? null
                    : { ...menu, rect: { x: menu.rect.x * fit, y: menu.rect.y * fit, width: menu.rect.width * fit, height: menu.rect.height * fit } };
            sink.send(JSON.stringify({ type: "select", menu: placed }));
        }
    };
    return {
        page: () => cast.page(),
        bind: (page: Page) => cast.bind(page, true),
        setPaused: (paused: boolean) => cast.setPaused(paused),
        input: async (message: ScreencastClientMessage) => {
            if (message.type === "newTab") {
                await openTab(context, message.url);
            } else if (message.type === "emulate") {
                const asked = askedDevice(message);
                if (asked !== "invalid") {
                    await emulate(asked);
                }
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

export interface LiveViewOptions {
    // The browser's DevTools HTTP endpoint (http://127.0.0.1:<port>): how the video path knows which tab the display
    // shows (front-tab.ts). Without it the picture follows only what the view itself opens, binds and loses.
    readonly endpoint?: string | undefined;
}

// Shows `context` on `sink`, the best way its browser allows. `key` names the display it was allocated under; this only
// asks whether one exists, since starting one now would put it on a display the browser isn't.
export const startLiveView = async (
    context: BrowserContext,
    key: string,
    sink: Sink,
    onError: (reason: string) => void,
    options: LiveViewOptions = {},
): Promise<LiveView> => {
    const display = displayOf(key);
    return display === undefined ? startFramesView(context, sink, onError) : startVideoView(context, display, sink, onError, options.endpoint);
};
