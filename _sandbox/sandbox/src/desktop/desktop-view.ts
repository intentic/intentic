import { upgradeWebSocket } from "@hono/node-server";
import { errorMessage } from "@intentic/base/errors";
import type { WSContext } from "hono/ws";
import { z } from "zod";
import { redeemTicket } from "../auth/tokens/ws-tickets.js";
import { regionsEqual, type Region } from "../browser/cast/region.js";
import { encodeVideo, startVideocast, type Videocast, type VideoFrame } from "../browser/cast/videocast.js";
import { startXInput, type XInput } from "../browser/cast/xinput.js";
import type { Services } from "../composition.js";
import {
    agentDesktop,
    type AgentDesktop,
    desktopWatched,
    OWNER_IDLE_MS,
    ownerDriving,
    ownerHandedBack,
    ownerHolds,
    readWindowPlace,
    windowListed,
} from "./agent-desktop.js";

/* /system/desktop-view: the sandbox's own desktop (agent-desktop.ts) as live video, and the owner's hands on it. The
   picture is x11grab of the whole display (videocast.ts), the hands XTEST on the same display (xinput.ts): one space,
   so a click lands on the pixel it was aimed at. Taking it over holds the desktop for the owner, which is what refuses
   the agent's own input while they drive; handing back, going idle or closing the view lets it go.

   Or one window alone, for a tab that shows one program: `window=<id>` on the socket's address, beside the ticket, with
   an id from system.desktop's `list`. The picture is then that window's inside (no frame, no title bar: the tab is the
   frame), clamped to the screen, and followed as it moves or resizes, each new place a fresh stream with its own
   `ready`. Pointer coordinates still arrive in the picture's own pixels and are moved onto the window here. Taking
   over raises the window first, so the keys go to what the owner is looking at. When the window closes the view says
   `gone` and closes the socket (1000): there is nothing left to show.

   Wire, client to server, JSON: ping; pause and resume (nobody is looking); control {driving} (take over, hand back);
   and, while driving, mouse {action, x, y, button, deltaX, deltaY}, key {key, ctrl, alt, shift} and text
   {text}, in the picture's own pixels. Server to client: ready {kind: "video", width, height, scale, codec}, then
   binary H.264 frames (tags 3 and 4, as videocast.ts encodes them); pong; held {owner} whenever the hold changes; and,
   on a window's view only, gone once that window has closed, just before the socket does. */

type Socket = WSContext;

// A socket holding more than this unsent is slower than the picture; frames are dropped until a keyframe finds it
// drained, as the browser view does.
const BACKLOG_LIMIT = 256 * 1024;
// How often a window's view asks where its window is now: a dragged window's picture catches up within this.
const FOLLOW_MS = 750;
// How many looks in a row may find a window off the window manager's list before it counts as closed. One could be a
// list read a moment before the window joined it; a window that is still off it on the next look is gone.
const UNLISTED_LOOKS = 2;

// Every message the view sends, read at the socket: a frame of any other shape is dropped, never replayed.
const MouseMessageSchema = z.object({
    type: z.literal("mouse"),
    action: z.enum(["move", "down", "up", "wheel"]),
    x: z.number(),
    y: z.number(),
    button: z.number().optional(),
    deltaX: z.number().optional(),
    deltaY: z.number().optional(),
});

export const DesktopViewMessageSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("ping") }),
    z.object({ type: z.literal("pause") }),
    z.object({ type: z.literal("resume") }),
    z.object({ type: z.literal("control"), driving: z.boolean() }),
    MouseMessageSchema,
    z.object({ type: z.literal("key"), key: z.string().min(1), ctrl: z.boolean().optional(), alt: z.boolean().optional(), shift: z.boolean().optional() }),
    z.object({ type: z.literal("text"), text: z.string() }),
]);

type MouseMessage = z.infer<typeof MouseMessageSchema>;
export type DesktopViewMessage = z.infer<typeof DesktopViewMessageSchema>;

const messageIn = (data: string): DesktopViewMessage | undefined => {
    try {
        const parsed = DesktopViewMessageSchema.safeParse(JSON.parse(data));
        return parsed.success ? parsed.data : undefined;
    } catch {
        // allow(silent-catch): a frame that is not JSON is not a message, and dropping it is the answer.
        return undefined;
    }
};

// What the socket holds unsent: hono's node adapter hands over the ws library's own socket as `raw`.
const BufferedSchema = z.object({ bufferedAmount: z.number() });

const backlogOf = (ws: Socket): number => {
    const raw = BufferedSchema.safeParse(ws.raw);
    return raw.success ? raw.data.bufferedAmount : 0;
};

// Key names the DOM and xdotool spell differently; everything else (letters, F-keys, arrows' "ArrowLeft") is mapped
// below or passes through.
const XKEYS = new Map([
    ["Enter", "Return"],
    ["Backspace", "BackSpace"],
    ["Escape", "Escape"],
    ["Tab", "Tab"],
    ["Delete", "Delete"],
    [" ", "space"],
    ["ArrowLeft", "Left"],
    ["ArrowRight", "Right"],
    ["ArrowUp", "Up"],
    ["ArrowDown", "Down"],
    ["PageUp", "Page_Up"],
    ["PageDown", "Page_Down"],
    ["Home", "Home"],
    ["End", "End"],
    ["Insert", "Insert"],
    // A chord's punctuation by keysym name: xdotool reads "ctrl+shift++" as a chord missing its key.
    ["+", "plus"],
    ["-", "minus"],
    ["=", "equal"],
    [",", "comma"],
    [".", "period"],
    ["/", "slash"],
    [";", "semicolon"],
    ["'", "apostrophe"],
    ["[", "bracketleft"],
    ["]", "bracketright"],
    ["\\", "backslash"],
    ["`", "grave"],
]);

export const desktopChord = (message: {
    readonly key: string;
    readonly ctrl?: boolean | undefined;
    readonly alt?: boolean | undefined;
    readonly shift?: boolean | undefined;
}): string =>
    [message.ctrl === true ? "ctrl" : "", message.alt === true ? "alt" : "", message.shift === true ? "shift" : "", XKEYS.get(message.key) ?? message.key]
        .filter((part) => part !== "")
        .join("+");

/* One window's picture. The encoder wants an even width and height (libx264 in yuv420p), and x11grab can only grab what
   is on the screen, so a window hanging off an edge is shown as the part of it that is not. */

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));
const even = (value: number): number => value - (value % 2);

export interface Place {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

// The rectangle of the screen a window's picture is: the window's inside, cut to the screen, at least 2×2 and even.
export const windowRegion = (place: Place, screen: { readonly width: number; readonly height: number }): Region => {
    const left = clamp(Math.round(place.x), 0, screen.width - 2);
    const top = clamp(Math.round(place.y), 0, screen.height - 2);
    const right = clamp(Math.round(place.x + place.width), left + 2, screen.width);
    const bottom = clamp(Math.round(place.y + place.height), top + 2, screen.height);
    return { x: left, y: top, width: even(right - left), height: even(bottom - top), scale: 1 };
};

// The whole screen, for the view of the desktop itself.
const wholeScreen = (screen: { readonly width: number; readonly height: number }): Region => ({ x: 0, y: 0, width: screen.width, height: screen.height, scale: 1 });

// What `window=` may say: an X window id as wmctrl spells it, or as a number. Anything else names no window.
const WINDOW_ID = /^(0x[0-9a-f]{1,8}|\d{1,10})$/i;

export const windowParam = (params: URLSearchParams): string | undefined | "invalid" => {
    const asked = params.get("window");
    if (asked === null) {
        return undefined;
    }
    return WINDOW_ID.test(asked) ? asked : "invalid";
};

// One pointer event onto the display, from the picture's pixels to the screen's by the picture's own origin (the
// window's place on a window's view, the corner on the desktop's). A point the client could not measure arrives as
// null, and is dropped rather than replayed as a click in the top-left corner.
export const replayPointer = (input: XInput, message: MouseMessage, origin: { readonly x: number; readonly y: number } = { x: 0, y: 0 }): void => {
    if (!Number.isFinite(message.x) || !Number.isFinite(message.y)) {
        return;
    }
    const x = Math.round(message.x + origin.x);
    const y = Math.round(message.y + origin.y);
    switch (message.action) {
        case "move":
            input.move(x, y);
            return;
        case "wheel":
            input.wheel(x, y, message.deltaX ?? 0, message.deltaY ?? 0);
            return;
        case "down":
            // One press per down: a double click already arrives as two of them, and X counts them itself. Replaying
            // the browser's click count on top would make every double click a triple.
            input.down(x, y, message.button);
            return;
        case "up":
            input.up(x, y, message.button);
            return;
    }
};

export const createDesktopViewRoute = (services: Services) =>
    upgradeWebSocket((c) => {
        let desk: AgentDesktop | undefined;
        let cast: Videocast | undefined;
        let input: XInput | undefined;
        let closed = false;
        let paused = false;
        let dropping = false;
        // Whether THIS view took the desktop: only the view that took it hands it back when it closes.
        let driving = false;
        let unregisterAccess: (() => void) | undefined;
        let lapse: ReturnType<typeof setTimeout> | undefined;
        // The window this view shows alone, by id; undefined for the whole desktop.
        let only: string | undefined;
        // The part of the screen the picture is, and the origin a pointer event is moved by. Undefined until a
        // window's view has found its window.
        let region: Region | undefined;
        let follower: ReturnType<typeof setInterval> | undefined;
        let following = false;
        let unlisted = 0;
        let unwatch: (() => void) | undefined;

        const announceHold = (ws: Socket): void => {
            ws.send(JSON.stringify({ type: "held", owner: ownerHolds() }));
        };

        // Says so when the hold runs out on its own, so the view does not keep showing a hold the agent no longer
        // waits on. Re-armed by every input, which is what renews the hold.
        const watchLapse = (ws: Socket): void => {
            clearTimeout(lapse);
            lapse = setTimeout(() => {
                if (!closed && !ownerHolds()) {
                    announceHold(ws);
                }
            }, OWNER_IDLE_MS + 50);
        };

        const deliver = (ws: Socket, frame: VideoFrame): void => {
            const backlog = backlogOf(ws);
            if (dropping) {
                if (!frame.key || backlog > BACKLOG_LIMIT) {
                    return;
                }
                dropping = false;
            } else if (backlog > BACKLOG_LIMIT) {
                dropping = true;
                return;
            }
            ws.send(encodeVideo(frame));
        };

        // Every start is a fresh stream that begins at a keyframe, announced by its own `ready`.
        const play = (ws: Socket): void => {
            const at = desk;
            const shown = region;
            if (at === undefined || shown === undefined || paused || closed) {
                return;
            }
            cast?.stop();
            dropping = false;
            cast = startVideocast(at.display, shown, {
                onFrame: (frame) => deliver(ws, frame),
                onCodec: (codec) => ws.send(JSON.stringify({ type: "ready", kind: "video", width: shown.width, height: shown.height, scale: 1, codec })),
                onExit: (reason) => {
                    if (!paused && !closed) {
                        services.logger.warn({ reason }, "desktop-view stream stopped");
                    }
                },
            });
        };

        const cleanup = (): void => {
            if (closed) {
                return;
            }
            closed = true;
            clearTimeout(lapse);
            clearInterval(follower);
            cast?.stop();
            input?.stop();
            unwatch?.();
            unregisterAccess?.();
            // A view closed mid-drive hands the desktop back at once rather than holding it for the idle window.
            if (driving) {
                ownerHandedBack();
            }
        };

        // The window has closed: said, then the socket closed, since a view of nothing has nothing more to send.
        const gone = (ws: Socket): void => {
            if (closed) {
                return;
            }
            ws.send(JSON.stringify({ type: "gone" }));
            cleanup();
            ws.close(1000, "window closed");
        };

        // Asks where the window is now; a move or a resize restarts the stream on its new place, announced by its own
        // `ready`. A read that failed for another reason changes nothing, and the next look asks again.
        const follow = async (ws: Socket): Promise<void> => {
            const at = desk;
            const id = only;
            if (at === undefined || id === undefined || closed || following) {
                return;
            }
            following = true;
            try {
                unlisted = windowListed(id) === false ? unlisted + 1 : 0;
                const place = unlisted >= UNLISTED_LOOKS ? "gone" : await readWindowPlace(at.display, id);
                if (closed) {
                    return;
                }
                if (place === "gone") {
                    gone(ws);
                    return;
                }
                if (place === undefined) {
                    return;
                }
                const next = windowRegion(place, at.display);
                if (region !== undefined && regionsEqual(region, next)) {
                    return;
                }
                region = next;
                play(ws);
            } finally {
                following = false;
            }
        };

        // Taking over a window's view brings that window up and gives it the keyboard, the way the agent's focus_window
        // does, so what the owner types goes where they are looking.
        const raise = async (): Promise<void> => {
            const at = desk;
            if (at === undefined || only === undefined) {
                return;
            }
            try {
                await at.screen.focusWindow(only);
            } catch (err) {
                services.logger.warn({ err }, "desktop-view could not raise its window");
            }
        };

        const onInput = (message: DesktopViewMessage, ws: Socket): void => {
            if (!driving || input === undefined) {
                return;
            }
            // Each input renews the hold, so the agent stays refused for as long as the owner is busy.
            const wasHeld = ownerHolds();
            ownerDriving();
            watchLapse(ws);
            if (!wasHeld) {
                announceHold(ws);
            }
            if (message.type === "mouse") {
                // Nowhere to aim before a window's view has found its window.
                if (region !== undefined) {
                    replayPointer(input, message, region);
                }
            } else if (message.type === "key") {
                input.key(desktopChord(message));
            } else if (message.type === "text") {
                // Split on newlines here, not trusted to the writer: a newline is Return, never a second xdotool command.
                message.text.split(/\r?\n/).forEach((part, index, parts) => {
                    if (part !== "") {
                        input?.type(part);
                    }
                    if (index < parts.length - 1) {
                        input?.key("Return");
                    }
                });
            }
        };

        return {
            onOpen: async (_event, ws) => {
                const params = new URL(c.req.url).searchParams;
                try {
                    // Driving the desktop is operating the sandbox, not watching it.
                    const caller = redeemTicket(services, params, "maintainer");
                    if (caller !== undefined) {
                        unregisterAccess = services.auth?.connections.register(caller, () => ws.close(1008, "authorization revoked"));
                    }
                } catch (err) {
                    services.logger.warn({ err }, "desktop-view ticket rejected");
                    ws.close(1008, "unauthorized");
                    return;
                }
                const asked = windowParam(params);
                if (asked === "invalid") {
                    // An id no window could have names nothing on the desktop, which is what `gone` says.
                    gone(ws);
                    return;
                }
                only = asked;
                try {
                    // Opening the view starts the desktop: the owner asking to see it is asking to use it.
                    desk = await agentDesktop();
                } catch (err) {
                    ws.send(JSON.stringify({ type: "error", message: `The desktop could not start: ${errorMessage(err)}` }));
                    cleanup();
                    ws.close(1011, "no desktop");
                    return;
                }
                if (closed) {
                    return;
                }
                input = startXInput(desk.display);
                unwatch = desktopWatched();
                announceHold(ws);
                if (only === undefined) {
                    region = wholeScreen(desk.display);
                    play(ws);
                    return;
                }
                // The first look finds the window (or that it is gone), and the stream starts there; later looks follow it.
                await follow(ws);
                if (closed) {
                    return;
                }
                follower = setInterval(() => {
                    if (!paused) {
                        void follow(ws);
                    }
                }, FOLLOW_MS);
            },
            onMessage: (event, ws) => {
                if (closed) {
                    return;
                }
                const message = messageIn(String(event.data));
                if (message === undefined) {
                    return;
                }
                switch (message.type) {
                    case "ping":
                        ws.send(JSON.stringify({ type: "pong" }));
                        return;
                    case "pause":
                        paused = true;
                        cast?.stop();
                        cast = undefined;
                        return;
                    case "resume":
                        paused = false;
                        play(ws);
                        return;
                    case "control":
                        driving = message.driving;
                        if (driving) {
                            ownerDriving();
                            watchLapse(ws);
                            void raise();
                        } else {
                            ownerHandedBack();
                        }
                        announceHold(ws);
                        return;
                    default:
                        onInput(message, ws);
                }
            },
            onClose: cleanup,
            onError: cleanup,
        };
    });
