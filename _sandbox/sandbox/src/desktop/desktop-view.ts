import { upgradeWebSocket } from "@hono/node-server";
import { errorMessage } from "@intentic/base/errors";
import type { WSContext } from "hono/ws";
import { z } from "zod";
import { redeemTicket } from "../auth/tokens/ws-tickets.js";
import { encodeVideo, startVideocast, type Videocast, type VideoFrame } from "../browser/cast/videocast.js";
import { startXInput, type XInput } from "../browser/cast/xinput.js";
import type { Services } from "../composition.js";
import { agentDesktop, type AgentDesktop, OWNER_IDLE_MS, ownerDriving, ownerHandedBack, ownerHolds } from "./agent-desktop.js";

/* /system/desktop-view: the sandbox's own desktop (agent-desktop.ts) as live video, and the owner's hands on it. The
   picture is x11grab of the whole display (videocast.ts), the hands XTEST on the same display (xinput.ts): one space,
   so a click lands on the pixel it was aimed at. Taking it over holds the desktop for the owner, which is what refuses
   the agent's own input while they drive; handing back, going idle or closing the view lets it go.

   Wire, client to server, JSON: ping; pause and resume (nobody is looking); control {driving} (take over, hand back);
   and, while driving, mouse {action, x, y, button, deltaX, deltaY}, key {key, ctrl, alt, shift} and text
   {text}, in the picture's own pixels. Server to client: ready {kind: "video", width, height, scale, codec}, then
   binary H.264 frames (tags 3 and 4, as videocast.ts encodes them); pong; held {owner} whenever the hold changes. */

type Socket = WSContext;

// A socket holding more than this unsent is slower than the picture; frames are dropped until a keyframe finds it
// drained, as the browser view does.
const BACKLOG_LIMIT = 256 * 1024;

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

// One pointer event onto the display. A point the client could not measure arrives as null, and is dropped rather than
// replayed as a click in the top-left corner.
export const replayPointer = (input: XInput, message: MouseMessage): void => {
    if (!Number.isFinite(message.x) || !Number.isFinite(message.y)) {
        return;
    }
    const x = Math.round(message.x);
    const y = Math.round(message.y);
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
            if (at === undefined || paused || closed) {
                return;
            }
            cast?.stop();
            dropping = false;
            const region = { x: 0, y: 0, width: at.display.width, height: at.display.height, scale: 1 };
            cast = startVideocast(at.display, region, {
                onFrame: (frame) => deliver(ws, frame),
                onCodec: (codec) => ws.send(JSON.stringify({ type: "ready", kind: "video", width: region.width, height: region.height, scale: 1, codec })),
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
            cast?.stop();
            input?.stop();
            unregisterAccess?.();
            // A view closed mid-drive hands the desktop back at once rather than holding it for the idle window.
            if (driving) {
                ownerHandedBack();
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
                replayPointer(input, message);
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
                try {
                    // Driving the desktop is operating the sandbox, not watching it.
                    const caller = redeemTicket(services, new URL(c.req.url).searchParams, "maintainer");
                    if (caller !== undefined) {
                        unregisterAccess = services.auth?.connections.register(caller, () => ws.close(1008, "authorization revoked"));
                    }
                } catch (err) {
                    services.logger.warn({ err }, "desktop-view ticket rejected");
                    ws.close(1008, "unauthorized");
                    return;
                }
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
                announceHold(ws);
                play(ws);
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
