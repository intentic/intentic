import { onScopeDispose, ref, type Ref, shallowRef, watch } from "vue";
import { keyIntent, type KeyFrame } from "./keyIntent";
import { viewportCoords } from "./viewportCoords";
import { socketUrl as wsSocketUrl } from "../sandbox/wsTicket";

/* ONE live view of the agent's browser: a `browser-*` session streamed over the daemon's /system/browser-view
 * WebSocket as image frames, with the owner's clicks and keystrokes going back the other way.
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
// The remote viewport (the daemon's screencast.ts VIEW_WIDTH/VIEW_HEIGHT) pointer coordinates map back onto.
export const VIEW_WIDTH = 1280;
export const VIEW_HEIGHT = 800;
// Pointer moves are throttled to roughly a frame. CDP dispatches each one synchronously in the page.
const MOVE_THROTTLE_MS = 40;
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
    // The current frame as a data URL. Undefined until the first one lands, the view shows `status` instead.
    // Its encoding changes under it: a low-cost jpeg while the page moves, then one sharp webp once it settles
    // (see screencast.ts), which is why the frame carries its own format rather than the client assuming one.
    readonly frame: Ref<string | undefined>;
    // What to say while there is no picture: connecting, reconnecting, or why there never will be one.
    readonly status: Ref<string | undefined>;
    // True while the user's input is being forwarded. Off by default, see the note above.
    readonly driving: Ref<boolean>;
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
    const select = ref<SelectMenu | undefined>();
    const socket = shallowRef<WebSocket | undefined>();
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
            let message: {
                type?: string;
                data?: string;
                format?: string;
                message?: string;
                pageId?: string;
                text?: string;
                menu?: SelectMenu | null;
            };
            try {
                message = JSON.parse(String(event.data)) as typeof message;
            } catch {
                return;
            }
            if (message.type === `frame` && message.data !== undefined && message.format !== undefined) {
                frame.value = `data:image/${message.format};base64,${message.data}`;
                status.value = undefined;
                return;
            }
            if (message.type === `ready`) {
                status.value = frame.value === undefined ? `Waiting for the first frame…` : undefined;
                return;
            }
            if (message.type === `selection`) {
                pendingSelection?.(message.text ?? ``);
                pendingSelection = undefined;
                return;
            }
            if (message.type === `select`) {
                // Sent after every release: a menu to draw, or null for "nothing is open now", which is what
                // closes one the user has clicked away from.
                select.value = message.menu ?? undefined;
                return;
            }
            if (message.type === `gone`) {
                // The tab closed between the relist and the click. Drop the pin and let the stream follow the
                // agent again, the strip's next poll drops the tab itself.
                pinned = undefined;
                return;
            }
            if (message.type === `error`) {
                // The daemon knows this session for good, a reconnect would only ask the same dead question.
                closing = true;
                status.value = message.message ?? `That browser session is gone.`;
                frame.value = undefined;
            }
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
    });

    let lastMove = 0;
    return {
        frame,
        status,
        driving,
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
            const now = Date.now();
            if (now - lastMove < MOVE_THROTTLE_MS) {
                return;
            }
            lastMove = now;
            send({ type: `mouse`, action: `move`, ...viewportCoords(event, element, VIEW_WIDTH, VIEW_HEIGHT) });
        },
        onMouseDown: (event, element) => {
            if (driving.value) {
                send({ type: `mouse`, action: `down`, ...viewportCoords(event, element, VIEW_WIDTH, VIEW_HEIGHT), button: event.button });
            }
        },
        onMouseUp: (event, element) => {
            if (driving.value) {
                send({ type: `mouse`, action: `up`, ...viewportCoords(event, element, VIEW_WIDTH, VIEW_HEIGHT), button: event.button });
            }
        },
        onWheel: (event, element) => {
            if (!driving.value) {
                return;
            }
            event.preventDefault();
            send({
                type: `mouse`,
                action: `wheel`,
                ...viewportCoords(event, element, VIEW_WIDTH, VIEW_HEIGHT),
                deltaX: event.deltaX,
                deltaY: event.deltaY,
            });
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
