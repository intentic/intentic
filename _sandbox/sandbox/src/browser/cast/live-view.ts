import { errorMessage } from "@intentic/base/errors";
import type { BrowserContext, Page } from "playwright";
import { type Display, displayOf } from "./display.js";
import {
    applySelect,
    cursorReporter,
    dispatchInput,
    encodeFrame,
    readSelect,
    readSelection,
    startScreencast,
    VIEW_HEIGHT,
    VIEW_WIDTH,
    type MouseMessage,
    type Screencast,
    type ScreencastClientMessage,
} from "./screencast.js";
import { encodeVideo, startVideocast, type Videocast } from "./videocast.js";
import { startXInput, type XInput } from "./xinput.js";

/* ONE LIVE BROWSER OVER ONE SOCKET, and the choice of how to show it.
 *
 * Both surfaces that put a Chromium in front of the owner — the agent's browser view and a connected account's
 * own profile window — are the same three things: a picture out, the owner's hands back in, and a rebind when
 * the thing being looked at moves. They differ only in whose browser it is. So the choice below is made once,
 * here, rather than twice in two routes that would drift.
 *
 * TWO WAYS TO SHOW A BROWSER, and they are not variations on each other:
 *
 *   VIDEO (videocast.ts + xinput.ts) is the real one. The browser is headed on a virtual X display of its own,
 *   so the display IS the browser: H.264 grabbed off it carries the whole window — chrome, the real cursor,
 *   the open <select> menu, the autofill drop-down, the file picker, the permission prompt — and XTEST drives
 *   that same display, so every one of those is simply clickable. One coordinate space, containing everything.
 *   It also costs about a hundredth of what the frames below do: three seconds of a settled page is ~23 kB,
 *   where one JPEG of it is 150-250 kB.
 *
 *   FRAMES (screencast.ts) is what is left when there is no display to grab: a sandbox whose owner has never
 *   installed the browser pack, where Chromium can only run headless and has no window at all. CDP's screencast
 *   photographs a page's compositor surface, which needs no X server and shows nothing outside the page. It is
 *   strictly worse and it is the honest answer there — the alternative is a view that says nothing is happening.
 *
 * WHICH ONE IS NOT A SETTING. It is whether the browser has a display, which is a fact about how it was
 * launched, so nothing here is configurable and there is no state where the two disagree.
 */

// Socket-shaped, so this module never imports hono. Both routes hand it their `ws`.
export interface Sink {
    readonly send: (data: string | Uint8Array<ArrayBuffer>) => void;
}

export interface LiveView {
    // What the picture is OF, for the things that are still page questions: the clipboard, and the address the
    // profile window reports. Undefined before the first page or after the last one closes.
    readonly page: () => Page | undefined;
    readonly bind: (page: Page) => Promise<void>;
    readonly setPaused: (paused: boolean) => Promise<void>;
    // A pointer or a keystroke. Answers with whatever the surface owes the client afterwards, which on the
    // frames path is a drop-down the click may have opened and on the video path is nothing at all.
    readonly input: (message: ScreencastClientMessage) => Promise<void>;
    readonly selection: () => Promise<string>;
    readonly chooseOption: (index: number) => Promise<void>;
    readonly stop: () => Promise<void>;
}

/* WHAT THE CLIENT IS TOLD IT IS LOOKING AT, in the one message it gets before any picture.
 *
 * `kind` decides which decoder the client builds, and the geometry decides what its pointer coordinates mean.
 * The two paths have DIFFERENT geometry and that is not an accident: the video is the whole window (chrome
 * included) at the display's size, while a screencast frame is the page alone at the viewport's. A client that
 * assumed one would put every click in the wrong place on the other, so neither is assumed — this says. */
export interface LiveReady {
    readonly type: "ready";
    readonly kind: "video" | "frames";
    readonly width: number;
    readonly height: number;
    // Only on the video path, and read out of the stream rather than written down. See videocast.ts.
    readonly codec?: string;
}

const startVideoView = (context: BrowserContext, display: Display, sink: Sink, onError: (reason: string) => void): LiveView => {
    const input: XInput = startXInput(display);
    let paused = false;
    let cast: Videocast | undefined;
    // The page is still tracked, because the clipboard and the address bar are page questions even when the
    // picture is not a page. Nothing here BINDS it: the video shows every tab at once, so which page is "on
    // screen" is whichever Chromium itself has in front, and following the newest is the closest true answer.
    let current: Page | undefined = context.pages().at(-1);
    const follow = (page: Page): void => {
        current = page;
        page.on("close", () => {
            if (current === page) {
                current = context.pages().at(-1);
            }
        });
    };
    context.on("page", follow);
    for (const page of context.pages()) {
        follow(page);
    }

    const run = (): void => {
        cast = startVideocast(display, {
            onFrame: (frame) => sink.send(encodeVideo(frame)),
            onCodec: (codec) => sink.send(JSON.stringify({ type: "ready", kind: "video", width: display.width, height: display.height, codec })),
            onExit: (reason) => {
                if (!paused) {
                    onError(reason);
                }
            },
        });
    };
    run();

    return {
        page: () => current,
        // Nothing to bind to: the picture is the window, and the window already shows every tab. Kept on the
        // interface because the frames path below genuinely does rebind, and the routes speak to one shape.
        bind: async () => {},
        setPaused: async (next) => {
            if (paused === next) {
                return;
            }
            paused = next;
            /* Pausing KILLS the encoder rather than muting it. Nobody is looking, and an encoder left running
             * costs a core for a picture that is dropped on arrival — which is exactly the cost pausing exists
             * to avoid. Resuming starts another, and because each viewer has its own encoder the first frame it
             * produces is a keyframe, so coming back needs nothing but starting. */
            if (next) {
                cast?.stop();
                cast = undefined;
            } else {
                run();
            }
        },
        input: async (message) => {
            if (message.type === "mouse") {
                pointer(input, message);
                return;
            }
            if (message.type === "text") {
                input.type(message.text);
                return;
            }
            if (message.type === "key") {
                input.key(chordOf(message));
            }
        },
        selection: async () => (current === undefined ? "" : readSelection(current)),
        // The native menu is in the picture and XTEST clicks it, so nothing ever asks for this here.
        chooseOption: async () => {},
        stop: async () => {
            context.off("page", follow);
            cast?.stop();
            cast = undefined;
            input.stop();
        },
    };
};

// A pointer event, in the display's own coordinates, which is the space both the picture and XTEST are in.
const pointer = (input: XInput, message: MouseMessage): void => {
    if (message.action === "wheel") {
        input.wheel(message.x, message.y, message.deltaX ?? 0, message.deltaY ?? 0);
        return;
    }
    if (message.action === "move") {
        input.move(message.x, message.y);
        return;
    }
    /* A DOUBLE CLICK IS TWO CLICKS, HERE. CDP took a `clickCount`; X has no such field — a renderer counts
     * presses itself and calls two inside its own threshold a double click. So the count is REPLAYED rather
     * than declared, which is also what a real mouse does. */
    const repeat = message.action === "down" ? Math.min(3, Math.max(1, message.clickCount ?? 1)) : 1;
    for (let index = 0; index < repeat; index++) {
        if (message.action === "down") {
            input.down(message.x, message.y, message.button);
        } else {
            input.up(message.x, message.y, message.button);
        }
    }
};

/* A KEY FRAME AS XTEST SPELLS IT: modifiers joined to a keysym with plus signs, which is xdotool's own syntax.
 *
 * The names mostly agree with the DOM's already (Return is the one that does not, and Escape/Home/End/the
 * arrows are identical), so this is a small table rather than a translation layer. A letter goes through as
 * itself: X takes `ctrl+a` and works out the keycode. */
const XKEYS: Record<string, string> = { Enter: "Return", Backspace: "BackSpace", Delete: "Delete", Escape: "Escape", Tab: "Tab" };

export const chordOf = (message: { readonly key: string; readonly ctrl?: boolean; readonly shift?: boolean; readonly alt?: boolean }): string => {
    const held = [message.ctrl === true ? "ctrl" : undefined, message.alt === true ? "alt" : undefined, message.shift === true ? "shift" : undefined];
    return [...held.filter((name) => name !== undefined), XKEYS[message.key] ?? message.key].join("+");
};

const startFramesView = (context: BrowserContext, sink: Sink, onError: (reason: string) => void): Promise<LiveView> =>
    startScreencast(context, (frame) => sink.send(encodeFrame(frame))).then((cast: Screencast) => {
        /* THE POINTER'S SHAPE, which this path has to ASK the page for and the video path simply photographs.
         * A compositor surface has no cursor in it — Chromium draws that in the window, above everything a
         * frame contains — so without this the owner's arrow stays an arrow over every link and text field.
         * Reported as it changes and worn by the operator's own pointer. */
        const reportCursor = cursorReporter((cursor) => sink.send(JSON.stringify({ type: "cursor", cursor })));
        sink.send(JSON.stringify({ type: "ready", kind: "frames", width: VIEW_WIDTH, height: VIEW_HEIGHT } satisfies LiveReady));
        return {
            page: () => cast.page(),
            bind: (page: Page) => cast.bind(page, true),
            setPaused: (paused: boolean) => cast.setPaused(paused),
            input: async (message: ScreencastClientMessage) => {
                const session = cast.attached();
                if (session === undefined) {
                    return;
                }
                // See Screencast.noteInput: told BEFORE the dispatch, or the frame answering this input is
                // judged as the still camera's own shake and dropped.
                cast.noteInput();
                await dispatchInput(session, message).catch((error: unknown) => onError(errorMessage(error)));
                if (message.type === "mouse" && message.action === "move") {
                    // Fire-and-forget and throttled: the shape follows the pointer, it never stands in front of
                    // the next input.
                    reportCursor(session, message.x, message.y);
                    return;
                }
                /* A CLICK MAY HAVE OPENED A DROP-DOWN NOBODY CAN SEE. Chromium draws that list outside the
                 * page, so no frame here will ever carry it — the whole reason the video path above exists.
                 * Asking after every release is how this path learns to draw one itself. */
                if (message.type === "mouse" && message.action === "up") {
                    const page = cast.page();
                    const menu = page === undefined ? undefined : await readSelect(page).catch(() => undefined);
                    sink.send(JSON.stringify({ type: "select", menu: menu ?? null }));
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
    });

/* Show `context` on `sink`, the best way its browser allows.
 *
 * `key` is what the display was allocated under (a profile owner, or `web`): this asks whether that browser HAS
 * one rather than starting one, because by the time anybody is watching, the browser is already running and a
 * display started now would be a display it is not on. */
export const startLiveView = async (context: BrowserContext, key: string, sink: Sink, onError: (reason: string) => void): Promise<LiveView> => {
    const display = displayOf(key);
    return display === undefined ? startFramesView(context, sink, onError) : startVideoView(context, display, sink, onError);
};
