import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal } from "@xterm/xterm";
import { WebLinksAddon } from "@xterm/addon-web-links";
import type { TerminalClientMessage, TerminalServerMessage } from "@intentic/sandbox-contract";
import { useGoogleIdentity } from "../useGoogleIdentity";
import { useSandbox } from "../sandbox/useSandbox";
import "@xterm/xterm/css/xterm.css";

/* One xterm ↔ one tmux session over the daemon's /system/terminal WebSocket — the shared core under the
 * terminal panel's tabs (useTerminal). Each session owns a persistent host div (xterm 6 must be open()ed
 * exactly once, so the div moves between containers instead of being rebuilt), auto-reconnects a dropped
 * socket with backoff, and pings every 30s against tunnel idle-reaping. The daemon's `exit` frame (the tmux
 * client ended: shell exited, or an attach-only `panel-*` session doesn't exist) is TERMINAL — it stops
 * reconnection and hands off to `onExit`, so a dead session can't spin an attach-fail loop. */

const PING_MS = 30_000;
const RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;
// A connection that lived this long was healthy — its drop resets the backoff. Shorter lives (refused,
// accept-then-crash) keep doubling, so a broken daemon is never hammered on a tight loop.
const STABLE_MS = 5000;
// The server answers every ping with a pong, so a healthy connection ALWAYS sees a frame within PING_MS —
// silence this long means half-open; close() hands the socket to the normal reconnect path.
const STALE_MS = 90_000;
// Scrollback snapshots (page-reload survival) above this size aren't worth the sessionStorage quota.
const SCROLLBACK_MAX_CHARS = 400_000;
const SCROLLBACK_LINES = 1000;

export type TerminalSession = {
    readonly name: string;
    readonly term: Terminal;
    readonly fit: FitAddon;
    readonly serialize: SerializeAddon;
    // Persistent xterm mount — moves in/out of containers as the surface shows/hides it.
    readonly host: HTMLElement;
    readonly observer: ResizeObserver;
    // The session-over handoff: the daemon's `exit` frame, or a dispose. Never called twice. Mutable because a
    // cached session outlives the tabs instance that created it — each instance rebinds it on cache hit, so an
    // exit always updates the LIVE surface's tab state, not a destroyed one's.
    onExit: (name: string) => void;
    socket?: WebSocket;
    reconnect?: number;
    retryDelay: number;
    // Set by dispose (and the exit frame) so the socket's close handler stops reconnecting.
    closing: boolean;
    // True while the connection is known-down — gates the disconnect/not-reachable banner to once per outage.
    down: boolean;
};

// Ctrl/Cmd+click opens a link (VSCode's terminal gesture) — a plain click must stay a selection/tmux
// gesture, and the forced-selection mousedown below turns it into one anyway. The URI is arbitrary program
// output, so the new tab gets no opener. Fired from the linkifier's mouseup, whose modifier state is real
// (the shiftKey forcing only touches mousedown), and whose user activation keeps popup blockers quiet.
const openLink = (event: MouseEvent, uri: string): void => {
    if (event.ctrlKey || event.metaKey) {
        window.open(uri, `_blank`, `noopener`);
    }
};

const send = (s: TerminalSession, message: TerminalClientMessage): void => {
    if (s.socket?.readyState === WebSocket.OPEN) {
        s.socket.send(JSON.stringify(message));
    }
};

// Build the authenticated wss URL for one session, or undefined if the sandbox isn't reachable / not signed in.
const socketUrl = async (name: string, cols: number, rows: number): Promise<string | undefined> => {
    const token = await useGoogleIdentity().getIdToken();
    if (token === undefined) {
        return undefined;
    }
    // Read the daemon URL and connect token together AFTER the token await, so both come from the same active
    // sandbox snapshot (a switch/list-refresh during the await would otherwise pair them across sandboxes).
    const base = useSandbox().daemonUrl.value;
    if (base === undefined || base === ``) {
        return undefined;
    }
    const connect = useSandbox().active.value?.token;
    if (connect === undefined) {
        return undefined;
    }
    const ws = base.replace(/^http/, `ws`);
    const params = new URLSearchParams({ token, connect, session: name, cols: String(cols), rows: String(rows) });
    return `${ws}/system/terminal?${params.toString()}`;
};

const scheduleRetry = (s: TerminalSession): void => {
    s.reconnect = window.setTimeout(() => void connectSocket(s), s.retryDelay);
    s.retryDelay = Math.min(s.retryDelay * 2, MAX_RETRY_MS);
};

// Open (or re-open) one session's PTY socket. Reconnects reuse the xterm — tmux redraws the screen on attach, so
// scrollback and the running processes both survive. Runs whether or not the host is mounted.
const connectSocket = async (s: TerminalSession): Promise<void> => {
    window.clearTimeout(s.reconnect);
    if (s.closing) {
        return;
    }
    const url = await socketUrl(s.name, s.term.cols, s.term.rows);
    // Disposed during the token fetch — don't resurrect a socket for a dead session.
    if (s.closing) {
        return;
    }
    if (url === undefined) {
        // Usually a transient startup state (panel opened before sign-in / daemon discovery resolved) — retry
        // on the same backoff as a dropped socket instead of parking the session forever.
        if (!s.down) {
            s.down = true;
            s.term.writeln(`\x1b[31mSandbox isn't reachable, or you're not signed in — finish setup and sign in with Google.\x1b[0m`);
        }
        scheduleRetry(s);
        return;
    }
    const ws = new WebSocket(url);
    // Supersede any straggler socket (its close handler sees s.socket !== ws, clears its own ping, and stays silent).
    s.socket?.close();
    s.socket = ws;
    // Socket-scoped state lives in this closure so it cannot outlive the socket: every close event (including a
    // superseded straggler's) clears its OWN ping interval before anything else.
    let ping: number | undefined;
    let openedAt = 0;
    let lastFrameAt = 0;
    ws.addEventListener(`open`, () => {
        if (s.closing || s.socket !== ws) {
            ws.close();
            return;
        }
        s.down = false;
        openedAt = Date.now();
        lastFrameAt = openedAt;
        // send() drops frames while CONNECTING, so push the live grid now — a refit during the handshake window
        // would otherwise leave the PTY at its spawn-time size until the next resize.
        send(s, { type: `resize`, cols: s.term.cols, rows: s.term.rows });
        ping = window.setInterval(() => {
            if (Date.now() - lastFrameAt > STALE_MS) {
                ws.close();
                return;
            }
            send(s, { type: `ping` });
        }, PING_MS);
    });
    ws.addEventListener(`message`, (event) => {
        // Any bytes from the server prove liveness, parseable or not.
        lastFrameAt = Date.now();
        let message: TerminalServerMessage;
        try {
            message = JSON.parse(String(event.data)) as TerminalServerMessage;
        } catch {
            return;
        }
        if (message.type === `data`) {
            s.term.write(message.data);
        } else if (message.type === `exit`) {
            // The tmux client ended (shell exited / attach-only session missing) — terminal, never a reconnect:
            // `-A` would recreate a session the user just ended, and a missing panel session would fail-loop.
            s.closing = true;
            s.onExit(s.name);
        }
    });
    ws.addEventListener(`close`, (event) => {
        window.clearInterval(ping);
        if (s.socket !== ws || s.closing) {
            return;
        }
        // Uptime-keyed backoff: a stable connection's drop retries at 1s; a connection that never opened or
        // died young keeps the escalated delay.
        if (openedAt !== 0 && Date.now() - openedAt > STABLE_MS) {
            s.retryDelay = RETRY_MS;
        }
        // Banner once per outage — the retries themselves are silent, and a successful reattach just redraws.
        if (!s.down) {
            s.down = true;
            s.term.writeln(`\r\n\x1b[90m[disconnected (${event.code}${event.reason === `` ? `` : `: ${event.reason}`})]\x1b[0m`);
            s.term.writeln(`\x1b[90m[reconnecting…]\x1b[0m`);
        }
        scheduleRetry(s);
    });
};

// One session's scrollback-snapshot key. Keyed by sandbox so a snapshot never restores into a same-named
// session on a different daemon.
const scrollbackKey = (name: string): string => `terminal-scrollback-${useSandbox().activeSandboxId.value}-${name}`;

// Snapshot one session's scrollback into sessionStorage (page-reload survival; dies with the tab). Called from
// the pagehide hook in useTerminal.ts; createTerminalSession restores and deletes the snapshot.
export const persistScrollback = (s: TerminalSession): void => {
    const snapshot = s.serialize.serialize({ scrollback: SCROLLBACK_LINES });
    if (snapshot.length > SCROLLBACK_MAX_CHARS) {
        return;
    }
    try {
        window.sessionStorage.setItem(scrollbackKey(s.name), snapshot);
    } catch {
        // quota exceeded — losing the snapshot is fine
    }
};

// Build one session's xterm + host + socket. The host stays out of the DOM until mountTerminalSession.
// `readOnly` makes it a log view (a background process's tab): stdin is disabled and keystrokes never reach
// the PTY — resize/ping still flow, tmux needs the grid to redraw.
export const createTerminalSession = (name: string, onExit: (name: string) => void, readOnly = false): TerminalSession => {
    const host = document.createElement(`div`);
    host.className = `h-full w-full`;
    // tmux runs with `mouse on` (so the wheel scrolls its scrollback), which means a drag is reported to tmux —
    // whose copy-mode selection is cleared the instant the button is released. Force xterm's OWN selection
    // instead: on a plain primary-button press set shiftKey, which xterm's shouldForceSelection honours (it then
    // selects locally and does NOT report the mouse to tmux). Capture phase so this runs before xterm's own
    // screen listener reads the event. ponytail: a full-screen mouse-driven TUI (vim/htop) won't receive plain
    // clicks while this is active — fine for a shell-centric sandbox terminal; gate on drag distance if it bites.
    host.addEventListener(
        `mousedown`,
        (event) => {
            if (event.button === 0 && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
                Object.defineProperty(event, `shiftKey`, { value: true, configurable: true });
            }
        },
        true,
    );
    const term = new Terminal({
        cursorBlink: !readOnly,
        disableStdin: readOnly,
        fontFamily: `'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace`,
        fontSize: 13,
        // OSC 8 hyperlinks (CLIs that emit explicit link escapes) — without this, xterm falls back to a
        // blocking confirm() dialog on activation.
        linkHandler: { activate: openLink },
        // Snapshotted at creation; fine while --color-terminal is constant across themes/modes.
        theme: { background: getComputedStyle(document.documentElement).getPropertyValue(`--color-terminal`).trim() || `#0a0a0a` },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const serialize = new SerializeAddon();
    term.loadAddon(serialize);
    // Plain-text URLs in output (a dev server's localhost line, pnpm's changelog link) become Ctrl/Cmd+clickable.
    term.loadAddon(new WebLinksAddon(openLink));
    // tmux runs with `set-clipboard on`, so a copy (mouse drag in copy-mode, `y`, …) arrives here as OSC 52
    // with a base64 payload — land it in the browser clipboard, which xterm otherwise ignores. `?` asks to
    // READ the clipboard; that stays unanswered. Guarded: the payload is arbitrary program output.
    term.parser.registerOscHandler(52, (data) => {
        const payload = data.slice(data.indexOf(`;`) + 1);
        if (payload === `?`) {
            return true;
        }
        try {
            void navigator.clipboard.writeText(new TextDecoder().decode(Uint8Array.from(atob(payload), (c) => c.charCodeAt(0)))).catch(() => {});
        } catch {
            // not valid base64 — drop it rather than kill the parser
        }
        return true;
    });
    // Copy a native selection (from the forced-selection drag above) DURING the mouse gesture, so the clipboard
    // write carries the transient user-activation browsers require — unlike the OSC 52 path, which arrives async
    // over the socket and is silently blocked outside a focused, secure Chrome tab. Skip empty (selection cleared
    // by output) and unchanged values to avoid redundant writes as the drag extends.
    let lastCopied = ``;
    term.onSelectionChange(() => {
        const selection = term.getSelection();
        if (selection !== `` && selection !== lastCopied) {
            lastCopied = selection;
            void navigator.clipboard.writeText(selection).catch(() => {});
        }
    });
    // Coalesce to one fit per frame — the panel's drag handle fires the observer per pointermove.
    let raf = 0;
    const observer = new ResizeObserver(() => {
        window.cancelAnimationFrame(raf);
        raf = window.requestAnimationFrame(() => {
            // Skip while detached (hidden host) or mid-drag at zero size — fit measures against a laid-out
            // element. A disposed session's removed host also measures 0, so a stray queued frame is inert.
            if (host.clientWidth === 0 || host.clientHeight === 0) {
                return;
            }
            fit.fit();
        });
    });
    observer.observe(host);
    const s: TerminalSession = { name, term, fit, serialize, host, observer, onExit, retryDelay: RETRY_MS, closing: false, down: false };
    // Keystrokes → pty; xterm's resize (from FitAddon) → pty resize. Wired once — send() targets the current
    // socket, so these survive reconnects. A read-only session wires no input path at all (disableStdin already
    // drops keystrokes; this also covers programmatic term.input, e.g. the touch extra-keys row).
    if (!readOnly) {
        term.onData((data) => send(s, { type: `input`, data }));
    }
    term.onResize(({ cols, rows }) => send(s, { type: `resize`, cols, rows }));
    // Restore the pre-reload scrollback first (xterm buffers writes made before open()); tmux's attach redraw
    // then paints the live screen below it.
    const snapshot = window.sessionStorage.getItem(scrollbackKey(name));
    if (snapshot !== null) {
        window.sessionStorage.removeItem(scrollbackKey(name));
        term.write(snapshot);
    }
    // Connect immediately, even before the host is mounted: a hidden session keeps streaming. xterm buffers
    // writes made before open(), so output accrues (at the default 80x24) until the first mount open()s the
    // renderer and fit() sends the real size — tmux then redraws at that size.
    void connectSocket(s);
    return s;
};

// Mount a session into a container: xterm must be open()ed against an in-DOM element, so the first mount
// open()s it there; later mounts just move the persistent host across.
export const mountTerminalSession = (s: TerminalSession, container: HTMLElement): void => {
    container.append(s.host);
    if (!s.term.element) {
        s.term.open(s.host);
    }
    s.fit.fit();
    // Unconditional resync: onResize only fires on a dimension CHANGE, so a PTY that drifted while hidden (or
    // fitted off-DOM at 80x24) would never converge otherwise. A same-size resize is a server no-op.
    send(s, { type: `resize`, cols: s.term.cols, rows: s.term.rows });
    s.term.focus();
};

// Fully dispose one session's client state. Does NOT kill the tmux session server-side.
export const disposeTerminalSession = (s: TerminalSession): void => {
    s.closing = true;
    window.clearTimeout(s.reconnect);
    s.observer.disconnect();
    s.socket?.close();
    s.term.dispose();
    s.host.remove();
};
