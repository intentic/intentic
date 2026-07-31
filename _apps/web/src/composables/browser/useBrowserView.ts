import { onScopeDispose, ref, type Ref, shallowRef, watch } from "vue";
import { viewportCoords } from "./viewportCoords";
import { useSandboxSession } from "../sandbox/sandboxSession";
import { useEndpoint } from "../sandbox/useEndpoint";
import { useSandbox } from "../sandbox/useSandbox";

/* ONE live view of the agent's browser: a `browser-*` session streamed over the daemon's /system/browser-view
 * WebSocket as image frames, with the owner's clicks and keystrokes going back the other way.
 *
 * This is NOT built like terminalSession.ts, and the difference is deliberate. A terminal's xterm is a
 * persistent host element shuffled between containers so a tab switch doesn't drop its scrollback — a browser
 * view has no scrollback to drop. Its content is the live page: unmount it, reconnect, and the very next frame
 * is the truth again. So the pane is an ordinary <img> in an ordinary component and this composable is plain
 * reactive state, which is what lets the Browsers view be a route rather than a pane in a tab machine.
 *
 * WATCHING IS THE DEFAULT; DRIVING IS A DECISION. The socket accepts input from the first frame, but nothing is
 * sent until the user presses Take control — because this view exists to answer "what is it doing?", and a stray
 * click landing in a form the agent is halfway through filling is the one way watching can do harm. */

const PING_MS = 30_000;
const RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;
// A connection that lived this long was healthy — its drop resets the backoff (terminalSession's rule).
const STABLE_MS = 5000;
// The daemon answers every ping with a pong, and a STILL page sends no frames at all — so silence this long is
// a half-open socket, not a quiet browser.
const STALE_MS = 90_000;
// The remote viewport (the daemon's screencast.ts VIEW_WIDTH/VIEW_HEIGHT) pointer coordinates map back onto.
export const VIEW_WIDTH = 1280;
export const VIEW_HEIGHT = 800;
// Pointer moves are throttled to roughly a frame — CDP dispatches each one synchronously in the page.
const MOVE_THROTTLE_MS = 40;
// Keys forwarded as key events; everything printable rides as an insertText `text` frame instead (the daemon's
// SPECIAL_KEYS is the other half of this list).
const SPECIAL_KEYS = new Set([`Enter`, `Backspace`, `Tab`, `Delete`, `Escape`, `ArrowLeft`, `ArrowRight`, `ArrowUp`, `ArrowDown`, `Home`, `End`]);

export interface BrowserView {
    // The current frame as a data URL. Undefined until the first one lands — the view shows `status` instead.
    // Its encoding changes under it: a low-cost jpeg while the page moves, then one sharp webp once it settles
    // (see screencast.ts), which is why the frame carries its own format rather than the client assuming one.
    readonly frame: Ref<string | undefined>;
    // What to say while there is no picture: connecting, reconnecting, or why there never will be one.
    readonly status: Ref<string | undefined>;
    // True while the user's input is being forwarded. Off by default — see the note above.
    readonly driving: Ref<boolean>;
    // Stream a specific page instead of following the agent. Pins daemon-side until the page closes.
    readonly bindPage: (pageId: string) => void;
    // The pointer/keyboard handlers the pane binds. All no-op unless `driving`, so taking control (and giving
    // it back) is a state flip rather than a listener rebuild — no window in which a half-attached pane
    // swallows or duplicates events.
    readonly onMouseMove: (event: MouseEvent, frame: HTMLElement) => void;
    readonly onMouseDown: (event: MouseEvent, frame: HTMLElement) => void;
    readonly onMouseUp: (event: MouseEvent, frame: HTMLElement) => void;
    readonly onWheel: (event: WheelEvent, frame: HTMLElement) => void;
    readonly onKeyDown: (event: KeyboardEvent) => void;
}

// Build the authenticated wss URL, or undefined if the sandbox isn't reachable / not signed in. Reads the base
// and connect token together AFTER the token await, so both come from one active-sandbox snapshot.
const socketUrl = async (name: string): Promise<string | undefined> => {
    const token = await useSandboxSession().getSessionToken();
    if (token === undefined) {
        return undefined;
    }
    const base = useEndpoint().daemonBase.value;
    if (base === undefined || base === ``) {
        return undefined;
    }
    const connect = useSandbox().active.value?.token;
    if (connect === undefined) {
        return undefined;
    }
    const params = new URLSearchParams({ token, connect, session: name });
    return `${base.replace(/^http/, `ws`)}/system/browser-view?${params.toString()}`;
};

/* Watch one session, following `name` as the view switches between browsers. A change tears the old socket
 * down and opens a new one — there is nothing to preserve across the switch, which is the whole reason this can
 * be so much simpler than the terminal's session cache. */
export const useBrowserView = (name: Ref<string | undefined>): BrowserView => {
    const frame = ref<string | undefined>();
    const status = ref<string | undefined>(`Connecting to the agent's browser…`);
    const driving = ref(false);
    const socket = shallowRef<WebSocket | undefined>();
    // The page the user picked, re-sent on every reconnect so a dropped socket doesn't silently hand them back
    // whichever tab the agent happens to be on.
    let pinned: string | undefined;
    let retryDelay = RETRY_MS;
    let reconnect: number | undefined;
    let closing = false;

    const send = (message: object): void => {
        if (socket.value?.readyState === WebSocket.OPEN) {
            socket.value.send(JSON.stringify(message));
        }
    };

    /* NOBODY LOOKING, NOTHING SENT. A browsing agent paints constantly, and a view left open on a background tab
     * (or behind another route — this composable's scope outlives a nav) would keep pulling every one of those
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
            // A socket that opened (or reconnected) while the tab was in the background starts out streaming —
            // the daemon has no way to know otherwise — so the first thing it hears is where we actually are.
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
            let message: { type?: string; data?: string; format?: string; message?: string; pageId?: string };
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
            if (message.type === `gone`) {
                // The tab closed between the relist and the click. Drop the pin and let the stream follow the
                // agent again — the strip's next poll drops the tab itself.
                pinned = undefined;
                return;
            }
            if (message.type === `error`) {
                // The daemon knows this session for good — a reconnect would only ask the same dead question.
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
        onKeyDown: (event) => {
            // Let real shortcuts (copy/paste/devtools, and the shell's own chords) through; only plain typing
            // and a few control keys are the page's.
            if (!driving.value || event.ctrlKey || event.metaKey || event.altKey) {
                return;
            }
            if (event.key.length === 1) {
                send({ type: `text`, text: event.key });
                event.preventDefault();
            } else if (SPECIAL_KEYS.has(event.key)) {
                send({ type: `key`, key: event.key });
                event.preventDefault();
            }
        },
    };
};
