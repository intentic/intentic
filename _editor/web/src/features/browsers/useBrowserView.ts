import { createBackoff } from "@intentic/base/async";
import { onScopeDispose, ref, type Ref, shallowRef, watch } from "vue";
import { FRAME_H264_DELTA, FRAME_H264_KEY, frameUrls } from "./frameUrls";
import { keyIntent, type KeyFrame } from "./keyIntent";
import { pointerFrame, type PointerAction } from "./pointerFrame";
import { canDecodeVideo, videoSink } from "./videoSink";
import { socketUrl as wsSocketUrl } from "../sandbox/client/wsTicket";

// One live view of the agent's browser over /system/browser-view, with clicks/keys going back. `ready` picks video
// (H.264 off the browser's own X display into a canvas, the whole window) or frames (CDP's page-only compositor
// surface into an img); kind and geometry always come off the wire. No scrollback to preserve like a terminal, so
// this is plain reactive state, and nothing is sent until the user takes control.

const PING_MS = 30_000;
const RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;
// A connection alive this long was healthy; its drop resets the backoff (terminalSession's rule).
const STABLE_MS = 5000;
// The daemon pongs every ping, and a still page sends no frames, so silence this long means a half-open socket.
const STALE_MS = 90_000;
// Assumed only between the socket opening and `ready` landing, when there's nothing to click on yet.
const VIEW_WIDTH = 1280;
const VIEW_HEIGHT = 880;
// Roughly one display frame, the rate CDP can act on anyway; each move is a few dozen bytes of JSON.
const MOVE_THROTTLE_MS = 16;
// How long Ctrl+C waits for the page's selection before the keystroke goes through anyway.
const SELECTION_TIMEOUT_MS = 1500;

// Mirrors the daemon's SelectMenu (screencast.ts); the browser package can't import that contract, so it's
// re-declared here.
export interface SelectMenu {
    readonly options: readonly { readonly label: string; readonly disabled: boolean }[];
    readonly selected: number;
    readonly rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

export interface BrowserView {
    // Which picture this is, so the pane mounts a canvas or an img; undefined until `ready`.
    readonly kind: Ref<"video" | "frames" | undefined>;
    // Remote geometry pointer coordinates map onto (whole window on video, page alone on frames); off the wire, never
    // assumed.
    readonly viewWidth: Ref<number>;
    readonly viewHeight: Ref<number>;
    // Where the video paints; the pane hands its canvas over on mount, nothing else uses it.
    readonly attachCanvas: (canvas: HTMLCanvasElement | undefined) => void;
    // The current frame as an object URL, frames path only; undefined until the first lands, always undefined on video.
    readonly frame: Ref<string | undefined>;
    // What to say while there's no picture: connecting, reconnecting, or why there never will be one.
    readonly status: Ref<string | undefined>;
    // True while the user's input is being forwarded; off by default.
    readonly driving: Ref<boolean>;
    // CSS cursor keyword from the daemon; a screencast carries none, Chromium draws it in the window.
    readonly cursor: Ref<string>;
    // Stream a specific page instead of following the agent; pins daemon-side until the page closes.
    readonly bindPage: (pageId: string) => void;
    // A native <select> renders outside the page, so no frame shows it; the daemon reports options instead.
    readonly select: Ref<SelectMenu | undefined>;
    readonly chooseOption: (index: number) => void;
    readonly closeSelect: () => void;
    // No-op unless `driving`, so taking control is a state flip, not a listener rebuild; no window where a
    // half-attached pane double-handles events.
    readonly onMouseMove: (event: MouseEvent, frame: HTMLElement) => void;
    readonly onMouseDown: (event: MouseEvent, frame: HTMLElement) => void;
    readonly onMouseUp: (event: MouseEvent, frame: HTMLElement) => void;
    readonly onWheel: (event: WheelEvent, frame: HTMLElement) => void;
    readonly onKeyDown: (event: KeyboardEvent) => void;
    // Left to the host: the remote clipboard is the sandbox's own, and the host's paste event carries the real one.
    readonly onPaste: (event: ClipboardEvent) => void;
}

// Authenticated wss URL, or undefined if unreachable/not signed in; base and token are read together after the
// token await, from one active-sandbox snapshot.
const socketUrl = (name: string): Promise<string | undefined> => wsSocketUrl(`/system/browser-view`, { session: name });

// Follows `name` as the view switches browsers; a change tears the old socket down and opens a new one, with
// nothing to preserve across the switch.
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
    // Turns each binary frame into an object URL, releasing ones the img has moved on from; frames path only, video
    // decodes into a canvas.
    const pictures = frameUrls();
    const video = videoSink((message) => {
        status.value = message;
    });
    // The page the user picked, re-sent on every reconnect so a dropped socket doesn't silently switch them back to
    // the agent's tab.
    let pinned: string | undefined;
    const ladder = createBackoff({ floorMs: RETRY_MS, capMs: MAX_RETRY_MS, stableMs: STABLE_MS });
    let reconnect: number | undefined;
    let closing = false;
    // The Ctrl+C in flight, waiting on the page's answer; one at a time, since a second press before the first
    // resolves is the same question twice.
    let pendingSelection: ((text: string) => void) | undefined;

    const send = (message: object): void => {
        if (socket.value?.readyState === WebSocket.OPEN) {
            socket.value.send(JSON.stringify(message));
        }
    };

    // Tells the client which decoder to build and what a click's coordinates mean. Sent before any picture; on video,
    // right as the codec is read out of the stream, just before the first keyframe.
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

    // What the remote page shows under the pointer, sent only on change (see `cursor` in the interface for why it
    // must be sent at all).
    const onCursor = (shape: string | undefined): void => {
        cursor.value = shape ?? `default`;
    };

    // One binary message, either picture kind; the first byte is the daemon's own tag (screencast.ts/videocast.ts
    // share the table). Read here rather than behind a mode flag, since a flag could go stale across a reconnect onto
    // a browser whose display just appeared.
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

    // The daemon knows this session is done for good; reconnecting would only ask the same dead question.
    const onError = (reason: string | undefined): void => {
        closing = true;
        status.value = reason ?? `That browser session is gone.`;
        frame.value = undefined;
    };

    // Everything on this socket besides a picture, kept separate so the message listener stays a two-way fork instead
    // of branching per message type.
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
                // Sent after every release: a menu to draw, or null to close one the user clicked away from.
                select.value = message.menu ?? undefined;
                break;
            case `gone`:
                // The tab closed between relist and click; drop the pin so the stream follows the agent again.
                pinned = undefined;
                break;
            case `error`:
                onError(message.message);
                break;
            default:
                break;
        }
    };

    // Asks the page what's selected, answered by the daemon's `selection` frame; the timeout keeps a slow tunnel from
    // stranding the keystroke.
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

    // Copying inside the agent's Chromium lands on the sandbox's clipboard, unreadable by the user's machine, so the
    // selection is fetched and rewritten to the user's own here. The chord still reaches the page afterward, since a
    // cut running first would delete the text being read.
    const copyOut = async (chord: KeyFrame): Promise<void> => {
        const text = await askSelection();
        if (text !== ``) {
            // Unavailable outside a secure context and refusable; a failed write must not eat the keystroke.
            await navigator.clipboard?.writeText(text).catch(() => undefined);
        }
        send(chord);
    };

    // A background or unmounted-but-alive view would otherwise keep pulling every frame down the tunnel to nothing
    // visible. The daemon holds the binding and pin across a pause, so resuming is one frame away, not a reconnect.
    const syncVisibility = (): void => send({ type: document.hidden ? `pause` : `resume` });
    document.addEventListener(`visibilitychange`, syncVisibility);

    const connect = async (): Promise<void> => {
        window.clearTimeout(reconnect);
        const session = name.value;
        if (closing || session === undefined) {
            return;
        }
        const url = await socketUrl(session);
        // The session may have changed while the token was in flight; that switch now owns the socket.
        if (closing || session !== name.value) {
            return;
        }
        if (url === undefined) {
            status.value = `The sandbox isn't reachable, or you're not signed in.`;
            reconnect = window.setTimeout(() => void connect(), ladder.next());
            return;
        }
        const ws = new WebSocket(url);
        // Frames arrive as binary; everything else on this socket is JSON, told apart by `event.data`.
        ws.binaryType = `arraybuffer`;
        // Supersedes any straggler socket; its handlers see `socket.value !== ws` and stay silent.
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
            // A newly (re)opened socket starts out streaming; the daemon can't know otherwise until told.
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
            // A picture, binary either way; the first byte says which kind (see takePicture).
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
            status.value = `Reconnecting…`;
            reconnect = window.setTimeout(() => void connect(), ladder.next(openedAt === 0 ? 0 : Date.now() - openedAt));
        });
    };

    const teardown = (): void => {
        window.clearTimeout(reconnect);
        // A copy waiting on a socket that's going away resolves empty rather than hanging until its timeout.
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
            ladder.reset();
            frame.value = undefined;
            driving.value = false;
            // A decoder holds state for the stream it was built for; the next browser's `ready` builds a new one.
            video.close();
            kind.value = undefined;
            // A shape from the browser being left describes nothing in the next one, which isn't being driven yet
            // anyway.
            cursor.value = `default`;
            // A menu from the browser being left has nothing left to point at.
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
        // An unreleased object URL holds its blob for the life of the document; a decoder holds buffers of its own.
        pictures.release();
        video.close();
    });

    let lastMove = 0;
    // Every pointer event routes through here, so `driving` is checked once and a frame built in one place
    // (pointerFrame); nothing reaches the page while only watching.
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
        // Closed here, not on the daemon's word: the pick applies to what the owner is looking at, and waiting for
        // confirmation would read as a click that did nothing.
        chooseOption: (index) => {
            select.value = undefined;
            send({ type: `selectOption`, index });
        },
        closeSelect: () => (select.value = undefined),
        onMouseMove: (event, element) => {
            if (!driving.value) {
                return;
            }
            // Only enough to stop a 1000 Hz mouse flooding the socket; one frame at 60 Hz is the rate the far side can
            // act on
            // anyway.
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
        // Which half of the keyboard a keystroke belongs to is keyIntent's call (paste stays with the host, select-all
        // doesn't); nothing happens unless the user has taken the wheel.
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
