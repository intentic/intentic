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

// One live browser over one socket; the choice of video vs frames is made once here, not per route. Video grabs the
// whole display in one coordinate space XTEST can click, far cheaper than frames; frames only photographs the page's
// compositor, for a headless browser. Which one runs is a fact of launch, not a setting.

// Socket-shaped, so this module never imports hono. Both routes hand it their `ws`.
export interface Sink {
    readonly send: (data: string | Uint8Array<ArrayBuffer>) => void;
}

export interface LiveView {
    // What the picture is of, for clipboard/address; undefined before the first page or after the last closes.
    readonly page: () => Page | undefined;
    readonly bind: (page: Page) => Promise<void>;
    readonly setPaused: (paused: boolean) => Promise<void>;
    // Pointer or keystroke; answers with whatever the surface owes after: a drop-down on frames, nothing on video.
    readonly input: (message: ScreencastClientMessage) => Promise<void>;
    readonly selection: () => Promise<string>;
    readonly chooseOption: (index: number) => Promise<void>;
    readonly stop: () => Promise<void>;
}

// One message telling the client what it's looking at: `kind` picks the decoder, geometry defines pointer coordinates.
// Video is the whole window at display size; frames is the page alone at viewport size, deliberately different.
export interface LiveReady {
    readonly type: "ready";
    readonly kind: "video" | "frames";
    readonly width: number;
    readonly height: number;
    // Only on the video path, read out of the stream rather than written down.
    readonly codec?: string;
}

const startVideoView = (context: BrowserContext, display: Display, sink: Sink, onError: (reason: string) => void): LiveView => {
    const input: XInput = startXInput(display);
    let paused = false;
    let cast: Videocast | undefined;
    // Page tracked for clipboard/address; not bound here, since video shows every tab and the newest is closest.
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
        // Nothing to bind to, since the window shows every tab; kept only because the frames path genuinely rebinds.
        bind: async () => {},
        setPaused: async (next) => {
            if (paused === next) {
                return;
            }
            paused = next;
            // Pausing kills the encoder, since an idle one still costs a core; resuming starts fresh with a keyframe.
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
    // Double click is replayed as two clicks, since X has no clickCount field, same as a real mouse.
    const repeat = message.action === "down" ? Math.min(3, Math.max(1, message.clickCount ?? 1)) : 1;
    for (let index = 0; index < repeat; index++) {
        if (message.action === "down") {
            input.down(message.x, message.y, message.button);
        } else {
            input.up(message.x, message.y, message.button);
        }
    }
};

// Modifiers join a keysym with plus signs (xdotool syntax); names mostly match the DOM's, letters pass through.
const XKEYS: Record<string, string> = { Enter: "Return", Backspace: "BackSpace", Delete: "Delete", Escape: "Escape", Tab: "Tab" };

export const chordOf = (message: { readonly key: string; readonly ctrl?: boolean; readonly shift?: boolean; readonly alt?: boolean }): string => {
    const held = [message.ctrl === true ? "ctrl" : undefined, message.alt === true ? "alt" : undefined, message.shift === true ? "shift" : undefined];
    return [...held.filter((name) => name !== undefined), XKEYS[message.key] ?? message.key].join("+");
};

const startFramesView = (context: BrowserContext, sink: Sink, onError: (reason: string) => void): Promise<LiveView> =>
    startScreencast(context, (frame) => sink.send(encodeFrame(frame))).then((cast: Screencast) => {
        // Cursor shape is asked for here, since a compositor surface has none; reported as it changes.
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
                // Told before the dispatch, or the answering frame reads as a camera shake and gets dropped.
                cast.noteInput();
                await dispatchInput(session, message).catch((error: unknown) => onError(errorMessage(error)));
                if (message.type === "mouse" && message.action === "move") {
                    // Fire-and-forget and throttled, so the cursor shape never blocks the next input.
                    reportCursor(session, message.x, message.y);
                    return;
                }
                // A click may open a drop-down no frame shows, since Chromium draws it outside the page.
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

// Shows `context` on `sink`, the best way its browser allows. `key` names the display it was allocated under; this only
// asks whether one exists, since starting one now would put it on a display the browser isn't.
export const startLiveView = async (context: BrowserContext, key: string, sink: Sink, onError: (reason: string) => void): Promise<LiveView> => {
    const display = displayOf(key);
    return display === undefined ? startFramesView(context, sink, onError) : startVideoView(context, display, sink, onError);
};
