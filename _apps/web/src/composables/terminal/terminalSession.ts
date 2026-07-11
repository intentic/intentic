import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useGoogleIdentity } from "../useGoogleIdentity";
import { useSandbox } from "../useSandbox";
import "@xterm/xterm/css/xterm.css";

/* One xterm ↔ one tmux session over the daemon's /system/terminal WebSocket — the shared core under BOTH
 * terminal surfaces: the workspace panel's tabs (useTerminal) and a panel page's embedded dev-server terminal
 * (TerminalView). Each session owns a persistent host div (xterm 6 must be open()ed exactly once, so the div
 * moves between containers instead of being rebuilt), auto-reconnects a dropped socket with backoff, and pings
 * every 30s against tunnel idle-reaping. The daemon's `exit` frame (the tmux client ended: shell exited, or an
 * attach-only `panel-*` session doesn't exist) is TERMINAL — it stops reconnection and hands off to `onExit`,
 * so a dead session can't spin an attach-fail loop. */

// Server→client frames (JSON). `data` is raw pty output; `exit` fires when the tmux client ends.
type ServerMessage = { readonly type: "data"; readonly data: string } | { readonly type: "exit"; readonly code: number };

const PING_MS = 30_000;
const RETRY_MS = 1000;
const MAX_RETRY_MS = 5000;

export type TerminalSession = {
    readonly name: string;
    readonly term: Terminal;
    readonly fit: FitAddon;
    // Persistent xterm mount — moves in/out of containers as the surface shows/hides it.
    readonly host: HTMLElement;
    readonly observer: ResizeObserver;
    // The session-over handoff: the daemon's `exit` frame, or a dispose. Never called twice.
    readonly onExit: (name: string) => void;
    socket?: WebSocket;
    ping?: number;
    reconnect?: number;
    retryDelay: number;
    // Set by dispose (and the exit frame) so the socket's close handler stops reconnecting.
    closing: boolean;
};

const send = (s: TerminalSession, message: object): void => {
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

// Open (or re-open) one session's PTY socket. Reconnects reuse the xterm — tmux redraws the screen on attach, so
// scrollback and the running processes both survive. Runs whether or not the host is mounted.
const connectSocket = async (s: TerminalSession): Promise<void> => {
    window.clearTimeout(s.reconnect);
    if (s.closing) {
        return;
    }
    const url = await socketUrl(s.name, s.term.cols, s.term.rows);
    if (url === undefined) {
        s.term.writeln(`\x1b[31mSandbox isn't reachable, or you're not signed in — finish setup and sign in with Google.\x1b[0m`);
        return;
    }
    const ws = new WebSocket(url);
    // Supersede any straggler socket (its close handler sees s.socket !== ws and stays silent).
    s.socket?.close();
    s.socket = ws;
    ws.addEventListener(`open`, () => {
        // send() drops frames while CONNECTING, so push the live grid now — a refit during the handshake window
        // would otherwise leave the PTY at its spawn-time size until the next resize.
        send(s, { type: `resize`, cols: s.term.cols, rows: s.term.rows });
        s.ping = window.setInterval(() => send(s, { type: `ping` }), PING_MS);
    });
    ws.addEventListener(`message`, (event) => {
        const message = JSON.parse(String(event.data)) as ServerMessage;
        if (message.type === `data`) {
            s.retryDelay = RETRY_MS;
            s.term.write(message.data);
        } else if (message.type === `exit`) {
            // The tmux client ended (shell exited / attach-only session missing) — terminal, never a reconnect:
            // `-A` would recreate a session the user just ended, and a missing panel session would fail-loop.
            s.closing = true;
            s.onExit(s.name);
        }
    });
    ws.addEventListener(`close`, (event) => {
        if (s.socket !== ws) {
            return;
        }
        window.clearInterval(s.ping);
        // The session is over (exit frame) or being torn down — don't respawn it.
        if (s.closing) {
            return;
        }
        s.term.writeln(`\r\n\x1b[90m[disconnected (${event.code}${event.reason === `` ? `` : `: ${event.reason}`})]\x1b[0m`);
        s.term.writeln(`\x1b[90m[reconnecting…]\x1b[0m`);
        s.reconnect = window.setTimeout(() => void connectSocket(s), s.retryDelay);
        s.retryDelay = Math.min(s.retryDelay * 2, MAX_RETRY_MS);
    });
};

// Build one session's xterm + host + socket. The host stays out of the DOM until mountTerminalSession.
export const createTerminalSession = (name: string, onExit: (name: string) => void): TerminalSession => {
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
        cursorBlink: true,
        fontFamily: `'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace`,
        fontSize: 13,
        // Snapshotted at creation; fine while --color-terminal is constant across themes/modes.
        theme: { background: getComputedStyle(document.documentElement).getPropertyValue(`--color-terminal`).trim() || `#0a0a0a` },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
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
    const observer = new ResizeObserver(() => {
        // Skip while detached (hidden host) or mid-drag at zero size — fit measures against a laid-out element.
        if (host.clientWidth === 0 || host.clientHeight === 0) {
            return;
        }
        fit.fit();
    });
    observer.observe(host);
    const s: TerminalSession = { name, term, fit, host, observer, onExit, retryDelay: RETRY_MS, closing: false };
    // Keystrokes → pty; xterm's resize (from FitAddon) → pty resize. Wired once — send() targets the current
    // socket, so these survive reconnects.
    term.onData((data) => send(s, { type: `input`, data }));
    term.onResize(({ cols, rows }) => send(s, { type: `resize`, cols, rows }));
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
    window.clearInterval(s.ping);
    s.observer.disconnect();
    s.socket?.close();
    s.term.dispose();
    s.host.remove();
};
