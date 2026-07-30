import { useSandboxSession } from "../sandbox/sandboxSession";
import { useSandbox } from "../sandbox/useSandbox";

/* One live view of the agent's browser ↔ one `browser-*` session over the daemon's /system/browser-view
 * WebSocket — the browser-shaped sibling of terminalSession.ts, and deliberately built to the same contract so
 * the panel's tab machinery (useTerminal) can hold either without knowing which: a persistent `host` element
 * that moves between containers instead of being rebuilt, a socket that keeps streaming while the host is
 * unmounted, auto-reconnect with backoff, a 30s ping against tunnel idle-reaping, and an `onExit` handoff when
 * the session is over for good.
 *
 * What it is NOT is an xterm. A browser session has no scrollback to persist, no grid to fit, and no local
 * echo: the daemon sends JPEG frames of whatever page the agent is on, and the pane is an <img> that scales
 * them. That is why the resize dance is missing here — the remote viewport is FIXED at the size the agent's
 * tools drive it at, so the pane letterboxes rather than reshaping the page under the agent's feet.
 *
 * WATCHING IS THE DEFAULT; DRIVING IS A DECISION. The socket accepts input from the first frame, but nothing
 * is sent until the user presses Take control — because this pane exists to answer "what is it doing?", and a
 * stray click landing in a form the agent is halfway through filling is the one way watching can do harm. The
 * button is in the pane's own header, next to the URL, so the answer to "where am I?" and the offer to step in
 * sit in the same place. */

const PING_MS = 30_000;
const RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;
// A connection that lived this long was healthy — its drop resets the backoff (terminalSession's rule).
const STABLE_MS = 5000;
// The daemon answers every ping with a pong, and a STILL page sends no frames at all — so silence this long is
// a half-open socket, not a quiet browser.
const STALE_MS = 90_000;
// The remote viewport (screencast.ts VIEW_WIDTH/VIEW_HEIGHT) every pointer coordinate is mapped back onto.
const VIEW_WIDTH = 1280;
const VIEW_HEIGHT = 800;
// Pointer moves are throttled to roughly a frame — CDP dispatches each one synchronously in the page.
const MOVE_THROTTLE_MS = 40;
// Keys forwarded as key events; everything printable rides as an insertText `text` frame instead (the daemon's
// SPECIAL_KEYS is the other half of this list).
const SPECIAL_KEYS = new Set([`Enter`, `Backspace`, `Tab`, `Delete`, `Escape`, `ArrowLeft`, `ArrowRight`, `ArrowUp`, `ArrowDown`, `Home`, `End`]);

export type BrowserSession = {
    // The discriminant the shared session cache dispatches on — a pane is either a terminal or a browser.
    readonly kind: `browser`;
    readonly name: string;
    // Persistent mount, moved in/out of containers as the surface shows/hides it (never rebuilt: rebuilding
    // would drop the last frame and blank the pane on every tab switch).
    readonly host: HTMLElement;
    readonly frame: HTMLImageElement;
    // The session-over handoff (the daemon says the session is gone, or a dispose). Mutable for the same reason
    // a terminal session's is: the cached session outlives the tabs instance that created it.
    onExit: (name: string) => void;
    socket?: WebSocket;
    reconnect?: number;
    retryDelay: number;
    closing: boolean;
    // True while the user is driving. Off by default — see the note above.
    driving: boolean;
};

const send = (s: BrowserSession, message: object): void => {
    if (s.socket?.readyState === WebSocket.OPEN) {
        s.socket.send(JSON.stringify(message));
    }
};

// Build the authenticated wss URL, or undefined if the sandbox isn't reachable / not signed in. Reads the
// daemon URL and connect token together AFTER the token await, so both come from one active-sandbox snapshot.
const socketUrl = async (name: string): Promise<string | undefined> => {
    const token = await useSandboxSession().getSessionToken();
    if (token === undefined) {
        return undefined;
    }
    const base = useSandbox().daemonUrl.value;
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

const setStatus = (s: BrowserSession, text: string | undefined): void => {
    const status = s.host.querySelector(`.browser-status`);
    if (status instanceof HTMLElement) {
        status.textContent = text ?? ``;
        status.parentElement?.classList.toggle(`hidden`, text === undefined);
    }
};

const setUrl = (s: BrowserSession, url: string): void => {
    const label = s.host.querySelector(`.browser-url`);
    if (label instanceof HTMLElement) {
        label.textContent = url;
    }
};

const scheduleRetry = (s: BrowserSession): void => {
    s.reconnect = window.setTimeout(() => void connectSocket(s), s.retryDelay);
    s.retryDelay = Math.min(s.retryDelay * 2, MAX_RETRY_MS);
};

// Open (or re-open) the view socket. Runs whether or not the host is mounted — a hidden browser tab keeps
// streaming, so switching to it shows the live page rather than a blank frame waiting on a handshake.
const connectSocket = async (s: BrowserSession): Promise<void> => {
    window.clearTimeout(s.reconnect);
    if (s.closing) {
        return;
    }
    const url = await socketUrl(s.name);
    if (s.closing) {
        return;
    }
    if (url === undefined) {
        setStatus(s, `Sandbox isn't reachable, or you're not signed in.`);
        scheduleRetry(s);
        return;
    }
    const ws = new WebSocket(url);
    // Supersede any straggler socket (its close handler sees s.socket !== ws and stays silent).
    s.socket?.close();
    s.socket = ws;
    let ping: number | undefined;
    let openedAt = 0;
    let lastFrameAt = 0;
    ws.addEventListener(`open`, () => {
        if (s.closing || s.socket !== ws) {
            ws.close();
            return;
        }
        openedAt = Date.now();
        lastFrameAt = openedAt;
        ping = window.setInterval(() => {
            if (Date.now() - lastFrameAt > STALE_MS) {
                ws.close();
                return;
            }
            send(s, { type: `ping` });
        }, PING_MS);
    });
    ws.addEventListener(`message`, (event) => {
        lastFrameAt = Date.now();
        let message: { type?: string; data?: string; message?: string };
        try {
            message = JSON.parse(String(event.data)) as typeof message;
        } catch {
            return;
        }
        if (message.type === `frame` && message.data !== undefined) {
            s.frame.src = `data:image/jpeg;base64,${message.data}`;
            s.frame.classList.remove(`hidden`);
            setStatus(s, undefined);
            return;
        }
        if (message.type === `ready`) {
            setStatus(s, s.frame.src === `` ? `Waiting for the first frame…` : undefined);
            return;
        }
        if (message.type === `error`) {
            // The daemon knows this session for good — a reconnect would only ask the same dead question, so
            // this is terminal and the tab retires (the same contract as the terminal socket's `exit` frame).
            s.closing = true;
            setStatus(s, message.message ?? `That browser session is gone.`);
            s.onExit(s.name);
        }
    });
    ws.addEventListener(`close`, () => {
        window.clearInterval(ping);
        if (s.socket !== ws || s.closing) {
            return;
        }
        if (openedAt !== 0 && Date.now() - openedAt > STABLE_MS) {
            s.retryDelay = RETRY_MS;
        }
        setStatus(s, `Reconnecting…`);
        scheduleRetry(s);
    });
};

// Map a pointer event onto the remote viewport. Measured against the IMAGE, not its container: the frame is
// object-contain'd, so the container's box is letterboxed and off by however much the aspect ratios differ.
const coords = (s: BrowserSession, event: MouseEvent): { x: number; y: number } => {
    const rect = s.frame.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
        return { x: 0, y: 0 };
    }
    return {
        x: Math.max(0, Math.round(((event.clientX - rect.left) / rect.width) * VIEW_WIDTH)),
        y: Math.max(0, Math.round(((event.clientY - rect.top) / rect.height) * VIEW_HEIGHT)),
    };
};

// Everything the pane's own chrome does: the URL line, and the one button that decides whether this pane is a
// window or a steering wheel. Built as DOM rather than as a component because the host has to survive being
// moved between containers (and documents, for the pop-out) without a Vue remount — the same reason the
// terminal's xterm host is built here rather than in the panel's template.
const buildHost = (s: BrowserSession): void => {
    // The pane keeps the panel's own surface (--color-terminal is dark in BOTH modes), so a page that doesn't
    // fill the box letterboxes into black rather than sitting in a bright rectangle inside a dark panel. The
    // two pieces of chrome — the header and the status line — are card-surfaced instead, because they are the
    // only text here and `text-muted` is tuned to read on the canvas, not on the terminal.
    s.host.className = `flex h-full w-full flex-col overflow-hidden bg-terminal`;

    const stage = document.createElement(`div`);
    stage.tabIndex = 0;
    stage.className = `relative flex min-h-0 flex-1 select-none items-center justify-center outline-none`;
    s.frame.className = `hidden h-full w-full object-contain`;
    s.frame.draggable = false;
    s.frame.alt = ``;
    const notice = document.createElement(`div`);
    notice.className = `absolute inset-0 flex items-center justify-center px-4`;
    const status = document.createElement(`span`);
    status.className = `browser-status rounded-md bg-card px-2 py-1 text-center text-xs text-muted`;
    status.textContent = `Connecting to the agent's browser…`;
    notice.append(status);
    stage.append(s.frame, notice);

    const bar = document.createElement(`div`);
    bar.className = `flex shrink-0 items-center gap-2 border-b border-line bg-card px-2 py-1 text-2xs text-muted`;
    const url = document.createElement(`span`);
    url.className = `browser-url truncate font-mono`;
    url.textContent = `about:blank`;
    const control = document.createElement(`button`);
    control.type = `button`;
    control.className = `ml-auto shrink-0 rounded border border-line px-1.5 py-0.5 transition-colors hover:text-content`;
    const paint = (): void => {
        control.textContent = s.driving ? `Watching only` : `Take control`;
        control.title = s.driving
            ? `Stop sending your clicks and keystrokes to the agent's browser`
            : `Send your clicks and keystrokes to the agent's browser`;
    };
    control.addEventListener(`click`, () => {
        s.driving = !s.driving;
        paint();
        if (s.driving) {
            stage.focus();
        }
    });
    bar.append(url, control);

    // Input is wired ONCE and gated on `driving`, so taking control (and giving it back) is a state flip
    // rather than a listener rebuild — no window in which a half-attached pane swallows or duplicates events.
    let lastMove = 0;
    stage.addEventListener(`mousemove`, (event) => {
        if (!s.driving) {
            return;
        }
        const now = Date.now();
        if (now - lastMove < MOVE_THROTTLE_MS) {
            return;
        }
        lastMove = now;
        const { x, y } = coords(s, event);
        send(s, { type: `mouse`, action: `move`, x, y });
    });
    stage.addEventListener(`mousedown`, (event) => {
        if (!s.driving) {
            return;
        }
        stage.focus();
        const { x, y } = coords(s, event);
        send(s, { type: `mouse`, action: `down`, x, y, button: event.button });
    });
    stage.addEventListener(`mouseup`, (event) => {
        if (!s.driving) {
            return;
        }
        const { x, y } = coords(s, event);
        send(s, { type: `mouse`, action: `up`, x, y, button: event.button });
    });
    stage.addEventListener(`wheel`, (event) => {
        if (!s.driving) {
            return;
        }
        event.preventDefault();
        const { x, y } = coords(s, event);
        send(s, { type: `mouse`, action: `wheel`, x, y, deltaX: event.deltaX, deltaY: event.deltaY });
    });
    stage.addEventListener(`keydown`, (event) => {
        // Let real shortcuts (copy/paste/devtools, and the shell's own chords) through; only plain typing and a
        // few control keys are the page's.
        if (!s.driving || event.ctrlKey || event.metaKey || event.altKey) {
            return;
        }
        if (event.key.length === 1) {
            send(s, { type: `text`, text: event.key });
            event.preventDefault();
        } else if (SPECIAL_KEYS.has(event.key)) {
            send(s, { type: `key`, key: event.key });
            event.preventDefault();
        }
    });
    stage.addEventListener(`contextmenu`, (event) => event.preventDefault());

    paint();
    s.host.append(bar, stage);
};

// Build one browser view's host + socket. The host stays out of the DOM until mountBrowserSession.
export const createBrowserSession = (name: string, onExit: (name: string) => void): BrowserSession => {
    const s: BrowserSession = {
        kind: `browser`,
        name,
        host: document.createElement(`div`),
        frame: document.createElement(`img`),
        onExit,
        retryDelay: RETRY_MS,
        closing: false,
        driving: false,
    };
    buildHost(s);
    void connectSocket(s);
    return s;
};

// The page the agent is on, from the daemon's session list — shown in the pane's header so the pane says where
// it is even between frames. Called by the tab machinery on every relist, so it tracks the agent's navigation.
export const noteBrowserUrl = (s: BrowserSession, url: string | undefined): void => {
    if (url !== undefined && url !== ``) {
        setUrl(s, url);
    }
};

export const mountBrowserSession = (s: BrowserSession, container: HTMLElement, focus = true): void => {
    container.append(s.host);
    if (focus) {
        // Focus the stage, not the host: keystrokes are only ever the page's while the user is driving, and
        // that is the element the keydown handler is on.
        const stage = s.host.lastElementChild;
        if (stage instanceof HTMLElement) {
            stage.focus();
        }
    }
};

// Unmount without tearing anything down — the socket keeps streaming and the last frame stays painted, so a
// remount is instant. Adopting the detached host home matters for the same reason it does for a terminal: while
// the panel floats in its own window the host is owned by THAT document, and a host merely removed stays owned
// by it after the window closes. An <img> has no renderer to lose there, but a node belonging to a dead realm
// is not something to keep a live pane pointed at.
export const parkBrowserSession = (s: BrowserSession): void => {
    s.host.remove();
    if (s.host.ownerDocument !== document) {
        document.adoptNode(s.host);
    }
};

// Fully dispose one view's client state. Does NOT close the agent's browser — that is the kill route's job.
export const disposeBrowserSession = (s: BrowserSession): void => {
    s.closing = true;
    window.clearTimeout(s.reconnect);
    s.socket?.close();
    s.host.remove();
};
