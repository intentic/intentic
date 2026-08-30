import { onScopeDispose, ref, type Ref, shallowRef, watch } from "vue";
import { FRAME_H264_DELTA, FRAME_H264_KEY, frameUrls } from "./frameUrls";
import { keyIntent, type KeyFrame } from "./keyIntent";
import { pointerFrame, type PointerAction } from "./pointerFrame";
import { canDecodeVideo, videoSink } from "./videoSink";
import { socketUrl as wsSocketUrl } from "../sandbox/wsTicket";

/* ONE live view of the agent's browser: a `browser-*` session over the daemon's /system/browser-view WebSocket,
 * with the owner's clicks and keystrokes going back the other way.

 * TWO KINDS OF PICTURE, and the daemon says which in its `ready` message rather than this guessing:
 *
 *   VIDEO is the real one. The browser is headed on a virtual X display of its own and the daemon grabs it as
 *   H.264, so what arrives is the whole WINDOW — chrome, the real cursor, an open <select>, the autofill
 *   drop-down, the file picker — and the owner's pointer drives that same display, so all of it is clickable.
 *   Painted into a <canvas> by videoSink.ts.
 *
 *   FRAMES is what is left when the browser has no display to grab, which means it is running headless, which
 *   means the sandbox has no browser pack. CDP photographs one page's compositor surface: no cursor, no native
 *   menu, nothing outside the page. Painted into an <img>.
 *
 * The two also have DIFFERENT GEOMETRY — the window including chrome, versus the page alone — so `viewWidth`
 * and `viewHeight` come off the wire instead of being constants here. A client that assumed either would put
 * every click in the wrong place on the other.
 *
 * This is NOT built like terminalSession.ts, and the difference is deliberate. A terminal's xterm is a
 * persistent host element shuffled between containers so a tab switch doesn't drop its scrollback, a browser
 * view has no scrollback to drop. Its content is the live page: unmount it, reconnect, and the very next frame
 * is the truth again. So the pane is an ordinary <img> in an ordinary component and this composable is plain
 * reactive state, which is what lets the Browsers view be a route rather than a pane in a tab machine.
 *
 * WATCHING IS THE DEFAULT; DRIVING IS A DECISION. The socket accepts input from the first frame, but nothing is
 * sent until the user presses Take control, because this view exists to answer "what is it doing?", and a stray
 * click landing in a form the agent is halfway through filling is the one way watching can do harm. */

const PING_MS = 30_000;
const RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;
// A connection that lived this long was healthy, its drop resets the backoff (terminalSession's rule).
const STABLE_MS = 5000;
// The daemon answers every ping with a pong, and a STILL page sends no frames at all, so silence this long is
// a half-open socket, not a quiet browser.
const STALE_MS = 90_000;
/* What to assume before the daemon has said otherwise. Only ever used for the moments between the socket
 * opening and its `ready` landing, when there is no picture to click on anyway. */
const VIEW_WIDTH = 1280;
const VIEW_HEIGHT = 880;
/* Pointer moves are throttled to roughly one display frame. This was 40ms, which is 25 Hz — a ceiling on how
 * responsive the pointer could be BEFORE the network had its turn, and coarse enough that a drag visited a
 * handful of points instead of tracing the path the hand took. 16ms is the rate the far side can act on anyway
 * (CDP dispatches each one synchronously in the page) and each frame is a few dozen bytes of JSON. */
const MOVE_THROTTLE_MS = 16;
// How long a Ctrl+C waits for the remote page to answer with its selection before the keystroke goes on
// without it. Long enough for a round trip through the tunnel, short enough not to strand the keyboard.
const SELECTION_TIMEOUT_MS = 1500;

// Mirrors the daemon's SelectMenu (screencast.ts), the browser can't import that contract package, the same
// reason the input frames are re-declared there rather than shared.
export interface SelectMenu {
    readonly options: readonly { readonly label: string; readonly disabled: boolean }[];
    readonly selected: number;
    readonly rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

export interface BrowserView {
    // Which picture this is, so the pane knows whether to mount a canvas or an <img>. Undefined until `ready`.
    readonly kind: Ref<"video" | "frames" | undefined>;
    // The remote geometry pointer coordinates map back onto: the whole window on video, the page alone on
    // frames. Off the wire, never assumed — see the note at the top of this file.
    readonly viewWidth: Ref<number>;
    readonly viewHeight: Ref<number>;
    // Where the video is painted. The pane hands its canvas over on mount; nothing else uses it.
    readonly attachCanvas: (canvas: HTMLCanvasElement | undefined) => void;
    // The current frame as an object URL, on the FRAMES path only. Undefined until the first one lands, and
    // undefined forever on video, where the picture lives in the canvas instead.
    readonly frame: Ref<string | undefined>;
    // What to say while there is no picture: connecting, reconnecting, or why there never will be one.
    readonly status: Ref<string | undefined>;
    // True while the user's input is being forwarded. Off by default, see the note above.
    readonly driving: Ref<boolean>;
    /* THE SHAPE THE POINTER SHOULD TAKE over the picture, as a CSS cursor keyword, reported by the daemon as it
     * changes under the pointer while driving.
     *
     * A screencast carries the page's compositor surface, and a cursor is not part of it — Chromium draws that
     * in the window, above everything a frame contains. So the arrow stayed an arrow over every link, every text
     * field and every drag handle in the remote page, and half of what tells a person a control is a control
     * never arrived. Applied by the pane to the element the frame paints in. */
    readonly cursor: Ref<string>;
    // Stream a specific page instead of following the agent. Pins daemon-side until the page closes.
    readonly bindPage: (pageId: string) => void;
    /* THE DROP-DOWN THE PICTURE CANNOT SHOW. An open <select> is a native menu Chromium draws outside the page,
     * so no frame ever carries it; the daemon answers a click that focused one with its options, and the pane
     * draws a real menu instead (BrowserSelectMenu). Undefined whenever no drop-down is open. */
    readonly select: Ref<SelectMenu | undefined>;
    readonly chooseOption: (index: number) => void;
    readonly closeSelect: () => void;
    // The pointer/keyboard handlers the pane binds. All no-op unless `driving`, so taking control (and giving
    // it back) is a state flip rather than a listener rebuild, no window in which a half-attached pane
    // swallows or duplicates events.
    readonly onMouseMove: (event: MouseEvent, frame: HTMLElement) => void;
    readonly onMouseDown: (event: MouseEvent, frame: HTMLElement) => void;
    readonly onMouseUp: (event: MouseEvent, frame: HTMLElement) => void;
    readonly onWheel: (event: WheelEvent, frame: HTMLElement) => void;
    readonly onKeyDown: (event: KeyboardEvent) => void;
    // THE ONE THING TYPING CANNOT DO. The remote Chromium has a clipboard of its own, inside the sandbox, that
    // nothing on the user's machine can write to, so Ctrl/Cmd+V arriving at the page would paste whatever that
    // browser last copied, not what the user meant. keyIntent deliberately lets the chord through to the host
    // browser instead, which turns it into a `paste` event carrying the real clipboard, and the text travels
    // down the same insertText path a keystroke does.
    readonly onPaste: (event: ClipboardEvent) => void;
}

// Build the authenticated wss URL, or undefined if the sandbox isn't reachable / not signed in. Reads the base
// and connect token together AFTER the token await, so both come from one active-sandbox snapshot.
const socketUrl = (name: string): Promise<string | undefined> => wsSocketUrl(`/system/browser-view`, { session: name });

/* Watch one session, following `name` as the view switches between browsers. A change tears the old socket
 * down and opens a new one, there is nothing to preserve across the switch, which is the whole reason this can
 * be so much simpler than the terminal's session cache. */
export const useBrowserView = (name: Ref<string | undefined>): BrowserView => {
    const frame = ref<string | undefined>();
    const status = ref<string | undefined>(`Connecting to the agent's browser…`);
    const driving = ref(false);
    const kind = ref<"video" | "frames" | undefined>();
    const viewWidth = ref(VIEW_WIDTH);
    const viewHeight = ref(VIEW_HEIGHT);
    const cursor = ref(`default`);
    const select = ref<SelectMenu | undefined>();
    const socket = shallowRef<WebSocket | undefined>();
    // Turns each binary frame into an object URL and lets go of the ones the <img> has moved on from. Used by
    // the frames path only; the video path decodes into a canvas instead.
    const pictures = frameUrls();
    const video = videoSink((message) => {
        status.value = message;
    });
    // The page the user picked, re-sent on every reconnect so a dropped socket doesn't silently hand them back
    // whichever tab the agent happens to be on.
    let pinned: string | undefined;
    let retryDelay = RETRY_MS;
    let reconnect: number | undefined;
    let closing = false;
    // The Ctrl+C in flight, waiting on the page's answer. One at a time: a second press before the first came
    // back is the same question asked twice.
    let pendingSelection: ((text: string) => void) | undefined;

    const send = (message: object): void => {
        if (socket.value?.readyState === WebSocket.OPEN) {
            socket.value.send(JSON.stringify(message));
        }
    };

    /* Attached, and now the client knows WHAT it is attached to: which decoder to build, and what the
     * coordinates of a click mean. The daemon sends this before any picture — on the video path it is emitted
     * the moment the codec has been read out of the stream, which is the same instant the first keyframe is
     * about to go out. */
    const onReady = (message: { kind?: string; width?: number; height?: number; codec?: string }): void => {
        kind.value = message.kind === `video` ? `video` : `frames`;
        viewWidth.value = message.width ?? viewWidth.value;
        viewHeight.value = message.height ?? viewHeight.value;
        if (kind.value === `video`) {
            if (!canDecodeVideo()) {
                status.value = `This browser can't play the live view. Chrome, Edge, Safari 16.4+ or Firefox 130+ can.`;
                return;
            }
            video.configure(message.codec ?? ``);
        }
        status.value = `Waiting for the first frame…`;
    };

    // What the remote page would be showing under the pointer. Sent only when it CHANGES, so this is quiet; see
    // the note on `cursor` in the interface for why it has to be sent at all.
    const onCursor = (shape: string | undefined): void => {
        cursor.value = shape ?? `default`;
    };

    /* ONE BINARY MESSAGE, WHICHEVER PICTURE IT IS. The tag byte is the daemon's (screencast.ts and
     * videocast.ts share the table): 0 jpeg, 1 webp, 2 svg, 3 a keyframe, 4 a delta. Read here rather than
     * behind a mode flag, because the tag is the truth and a flag is a claim about it — and a socket that
     * reconnects onto a browser whose display appeared in the meantime would have the flag wrong. */
    const takePicture = (data: ArrayBuffer): void => {
        const bytes = new Uint8Array(data);
        const tag = bytes[0];
        if (tag === FRAME_H264_KEY || tag === FRAME_H264_DELTA) {
            video.push(bytes.subarray(1), tag === FRAME_H264_KEY);
            status.value = undefined;
            return;
        }
        const picture = pictures.from(data);
        if (picture !== undefined) {
            frame.value = picture;
            status.value = undefined;
        }
    };

    const onSelection = (text: string | undefined): void => {
        pendingSelection?.(text ?? ``);
        pendingSelection = undefined;
    };

    // The daemon knows this session for good, so a reconnect would only ask the same dead question.
    const onError = (reason: string | undefined): void => {
        closing = true;
        status.value = reason ?? `That browser session is gone.`;
        frame.value = undefined;
    };

    // Everything on this socket that is not a picture. Its own function so the message listener stays a fork
    // between the two kinds rather than a branch per message type on top of it.
    const handleJson = (raw: string): void => {
        let message: {
            type?: string;
            kind?: string;
            width?: number;
            height?: number;
            codec?: string;
            message?: string;
            text?: string;
            cursor?: string;
            menu?: SelectMenu | null;
        };
        try {
            message = JSON.parse(raw) as typeof message;
        } catch {
            return;
        }
        switch (message.type) {
            case `ready`:
                onReady(message);
                break;
            case `cursor`:
                onCursor(message.cursor);
                break;
            case `selection`:
                onSelection(message.text);
                break;
            case `select`:
                // Sent after every release: a menu to draw, or null for "nothing is open now", which is what
                // closes one the user has clicked away from.
                select.value = message.menu ?? undefined;
                break;
            case `gone`:
                // The tab closed between the relist and the click. Drop the pin and let the stream follow the
                // agent again, the strip's next poll drops the tab itself.
                pinned = undefined;
                break;
            case `error`:
                onError(message.message);
                break;
            default:
                break;
        }
    };

    // Ask the page what it has selected. Answered by the daemon's `selection` frame; the timeout is what keeps a
    // slow tunnel from stranding the keystroke that asked.
    const askSelection = (): Promise<string> =>
        new Promise((resolve) => {
            pendingSelection?.(``);
            pendingSelection = resolve;
            send({ type: `selection` });
            window.setTimeout(() => {
                if (pendingSelection === resolve) {
                    pendingSelection = undefined;
                    resolve(``);
                }
            }, SELECTION_TIMEOUT_MS);
        });

    /* COPY AND CUT, ACROSS THE GAP. Copying inside the agent's Chromium puts text on the SANDBOX's clipboard,
     * which the user's machine can't read, so the selection is fetched and written to their own clipboard here.
     * The chord still goes to the page afterwards (its own handlers may care), and only afterwards: a cut that
     * ran first would have deleted the very text being read. */
    const copyOut = async (chord: KeyFrame): Promise<void> => {
        const text = await askSelection();
        if (text !== ``) {
            // Unavailable outside a secure context, and refusable, a failed write must not eat the keystroke.
            await navigator.clipboard?.writeText(text).catch(() => undefined);
        }
        send(chord);
    };

    /* NOBODY LOOKING, NOTHING SENT. A browsing agent paints constantly, and a view left open on a background tab
     * (or behind another route, this composable's scope outlives a nav) would keep pulling every one of those
     * frames down the tunnel to an <img> nobody can see. The daemon holds the binding and the pin across a
     * pause, so coming back is one frame away rather than a reconnect. */
    const syncVisibility = (): void => send({ type: document.hidden ? `pause` : `resume` });
    document.addEventListener(`visibilitychange`, syncVisibility);

    const connect = async (): Promise<void> => {
        window.clearTimeout(reconnect);
        const session = name.value;
        if (closing || session === undefined) {
            return;
        }
        const url = await socketUrl(session);
        // The session may have changed while the token was in flight; that switch owns the socket now.
        if (closing || session !== name.value) {
            return;
        }
        if (url === undefined) {
            status.value = `The sandbox isn't reachable, or you're not signed in.`;
            reconnect = window.setTimeout(() => void connect(), retryDelay);
            retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
            return;
        }
        const ws = new WebSocket(url);
        // Frames arrive as binary; everything else on this socket is JSON, and `event.data` tells them apart.
        ws.binaryType = `arraybuffer`;
        // Supersede any straggler socket (its handlers see socket.value !== ws and stay silent).
        socket.value?.close();
        socket.value = ws;
        let ping: number | undefined;
        let openedAt = 0;
        let lastFrameAt = 0;
        ws.addEventListener(`open`, () => {
            if (closing || socket.value !== ws) {
                ws.close();
                return;
            }
            openedAt = Date.now();
            lastFrameAt = openedAt;
            if (pinned !== undefined) {
                ws.send(JSON.stringify({ type: `bind`, pageId: pinned }));
            }
            // A socket that opened (or reconnected) while the tab was in the background starts out streaming,
            // the daemon has no way to know otherwise, so the first thing it hears is where we actually are.
            syncVisibility();
            ping = window.setInterval(() => {
                if (Date.now() - lastFrameAt > STALE_MS) {
                    ws.close();
                    return;
                }
                send({ type: `ping` });
            }, PING_MS);
        });
        ws.addEventListener(`message`, (event) => {
            lastFrameAt = Date.now();
            // A picture. Binary either way, and the FIRST BYTE says which kind: a coded video frame goes to the
            // decoder, an image becomes an object URL for the <img>. See takePicture.
            if (event.data instanceof ArrayBuffer) {
                takePicture(event.data);
                return;
            }
            handleJson(String(event.data));
        });
        ws.addEventListener(`close`, () => {
            window.clearInterval(ping);
            if (socket.value !== ws || closing) {
                return;
            }
            if (openedAt !== 0 && Date.now() - openedAt > STABLE_MS) {
                retryDelay = RETRY_MS;
            }
            status.value = `Reconnecting…`;
            reconnect = window.setTimeout(() => void connect(), retryDelay);
            retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
        });
    };

    const teardown = (): void => {
        window.clearTimeout(reconnect);
        // A copy waiting on a socket that is going away answers empty rather than hanging until its timeout.
        pendingSelection?.(``);
        pendingSelection = undefined;
        socket.value?.close();
        socket.value = undefined;
    };

    watch(
        name,
        () => {
            teardown();
            closing = false;
            pinned = undefined;
            retryDelay = RETRY_MS;
            frame.value = undefined;
            driving.value = false;
            // A decoder holds the state of the stream it was built for, and the next browser is a different
            // stream: its `ready` builds another.
            video.close();
            kind.value = undefined;
            // A shape read off the browser being switched away from describes nothing in the next one, and the
            // next one is not being driven yet anyway.
            cursor.value = `default`;
            // A menu describing a control in the browser being switched away from has nothing left to point at.
            select.value = undefined;
            status.value = name.value === undefined ? undefined : `Connecting to the agent's browser…`;
            void connect();
        },
        { immediate: true },
    );

    onScopeDispose(() => {
        closing = true;
        document.removeEventListener(`visibilitychange`, syncVisibility);
        teardown();
        // An object URL holds its blob until it is revoked, so a view left without this leaks the last frames of
        // every browser it ever showed for the life of the document. A decoder holds buffers of its own.
        pictures.release();
        video.close();
    });

    let lastMove = 0;
    // Every pointer event goes out through here, so `driving` is checked in ONE place and a frame is built in
    // one place (pointerFrame, which both surfaces share). Nothing reaches the page while the user is watching.
    const sendPointer = (action: PointerAction, event: MouseEvent, element: HTMLElement): void => {
        if (driving.value) {
            send(pointerFrame(action, event, element, viewWidth.value, viewHeight.value));
        }
    };
    return {
        kind,
        viewWidth,
        viewHeight,
        attachCanvas: video.attach,
        frame,
        status,
        driving,
        cursor,
        bindPage: (pageId) => {
            pinned = pageId;
            send({ type: `bind`, pageId });
        },
        select,
        // Closed here rather than on the daemon's say-so: the pick is applied to the page the owner is looking
        // at, and leaving the menu up until a frame confirms it would read as a click that did nothing.
        chooseOption: (index) => {
            select.value = undefined;
            send({ type: `selectOption`, index });
        },
        closeSelect: () => (select.value = undefined),
        onMouseMove: (event, element) => {
            if (!driving.value) {
                return;
            }
            /* Throttled, but only enough to stop a 1000 Hz mouse flooding the socket. It used to be 40ms, which
             * capped the pointer at 25 Hz BEFORE the network had its turn, and a drag sampled that coarsely does
             * not trace what the hand did — it visits a handful of points on the way. One frame at 60 Hz is the
             * rate the far side can act on anyway. */
            const now = Date.now();
            if (now - lastMove < MOVE_THROTTLE_MS) {
                return;
            }
            lastMove = now;
            sendPointer(`move`, event, element);
        },
        onMouseDown: (event, element) => sendPointer(`down`, event, element),
        onMouseUp: (event, element) => sendPointer(`up`, event, element),
        onWheel: (event, element) => {
            if (!driving.value) {
                return;
            }
            event.preventDefault();
            sendPointer(`wheel`, event, element);
        },
        // Which half of the keyboard a keystroke belongs to is keyIntent's decision, see that module for why a
        // paste is left to the host and a select-all is not. Nothing at all happens unless the user took the
        // wheel: watching must not put keys into the page the agent is working in.
        onKeyDown: (event) => {
            if (!driving.value) {
                return;
            }
            const intent = keyIntent(event);
            if (intent.kind === `host`) {
                return;
            }
            event.preventDefault();
            if (intent.kind === `text`) {
                send({ type: `text`, text: intent.text });
            } else if (intent.kind === `key`) {
                send(intent.frame);
            } else {
                void copyOut(intent.frame);
            }
        },
        onPaste: (event) => {
            const text = event.clipboardData?.getData(`text/plain`);
            if (!driving.value || text === undefined || text === ``) {
                return;
            }
            event.preventDefault();
            send({ type: `text`, text });
        },
    };
};
