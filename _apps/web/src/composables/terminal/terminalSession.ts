import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal } from "@xterm/xterm";
import { WebglAddon } from "@xterm/addon-webgl";
import type { TerminalClientMessage, TerminalServerMessage } from "@intentic/sandbox-contract";
import { useDevice } from "@intentic-app/ui";
import { boundCommand } from "../commands/useCommands";
import { isApplePlatform } from "../commands/keybindings";
import { useGoogleIdentity } from "../useGoogleIdentity";
import { useSandbox } from "../sandbox/useSandbox";
import { registerFilePathLinks } from "./terminalFileLinks";
import { registerUrlLinks } from "./terminalUrlLinks";
import { openLoopbackPreview, parseLoopbackLink } from "./portPreview";
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
// A pressed pointer that wanders at least this far (px, per axis) is a selection drag; shorter is a click.
const DRAG_PX = 5;

export type TerminalSession = {
    readonly name: string;
    readonly term: Terminal;
    readonly serialize: SerializeAddon;
    // Persistent xterm mount — moves in/out of containers as the surface shows/hides it.
    readonly host: HTMLElement;
    // Tears down the fit triggers (ResizeObserver + window resize listener) for the WINDOW the host last lived
    // in — rebuilt when a mount moves the host into another document (the pop-out pip window), since both are
    // per-window machinery that stops tracking an element adopted elsewhere.
    unobserve?: () => void;
    // The document of the LAST mount — mountTerminalSession's move signal. host.ownerDocument can't be it: the
    // pop-out Teleport adopts the mounted host (with the whole panel) into the pip document BEFORE the remount
    // watcher runs, so by then host and container already agree and the move would go undetected.
    mountedDocument: Document;
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

// Ctrl/Cmd+click opens a link (VSCode's terminal gesture) — a plain click must stay a click/selection
// gesture (createTerminalSession's drag gate routes it to tmux). Ctrl+click bypasses that gate, so the
// linkifier's mouseup here is the trusted event: real modifier state, and the user activation that keeps
// popup blockers quiet. A coarse pointer has no modifier to hold and no way to select wrapped text, so there a
// tap IS the gesture — otherwise the link a phone needs most (the agent's OAuth URL) is the one it can't reach.
// A localhost link names the SANDBOX's loopback (the printing process runs inside the remote container), so it
// opens as a forwarded-port preview instead of a dead tab. Any other URI is arbitrary program output — the new
// tab gets no opener.
const openLink = (event: MouseEvent, uri: string): void => {
    if (!event.ctrlKey && !event.metaKey && !useDevice().coarse.value) {
        return;
    }
    const loopback = parseLoopbackLink(uri);
    if (loopback !== undefined) {
        openLoopbackPreview(loopback);
        return;
    }
    window.open(uri, `_blank`, `noopener`);
};

const send = (s: TerminalSession, message: TerminalClientMessage): void => {
    if (s.socket?.readyState === WebSocket.OPEN) {
        s.socket.send(JSON.stringify(message));
    }
};

// Swap xterm's default DOM renderer for the GPU one — the DOM renderer repaints per cell and pegs the main
// thread under the flooding output this terminal sees (docker pulls, pnpm install, turbo/vite). Must run AFTER
// term.open() (the addon needs the canvas). A lost GL context (GPU sleep, backgrounded tab, or too many live
// contexts across many opened tabs) would otherwise blank the terminal — dispose on loss so xterm falls back to
// the DOM renderer rather than showing nothing. A missing WebGL2 (blocklisted driver) throws on load, same
// fallback. Loaded once per session, from the first mount's open() guard.
const loadWebglRenderer = (term: Terminal): void => {
    try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        term.loadAddon(webgl);
    } catch {
        // No WebGL2 available — xterm keeps its default DOM renderer.
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

// The private render-service surface both fit and the redraw-forcing resize need. The same access
// @xterm/addon-fit makes (its own TODO admits it) — xterm exposes no public cell-metrics API.
type XtermCore = { _renderService: { clear: () => void; dimensions: { css: { cell: { width: number; height: number } } } } };
const coreOf = (term: Terminal): XtermCore => (term as unknown as { _core: XtermCore })._core;

// xterm's viewport reserves this much for its native scrollbar (ViewportConstants.DEFAULT_SCROLL_BAR_WIDTH).
const SCROLLBAR_PX = 14;

// Fit the grid to the host's box, measured in the HOST'S OWN realm (clientWidth/Height). Not @xterm/addon-fit:
// its proposeDimensions measures through the GLOBAL window's getComputedStyle, which is cross-realm for a host
// living in the pop-out pip document — where it can silently misresolve, no-oping every fit and leaving the
// PTY at the docked grid while the window floats at another size entirely.
const fitSession = (s: TerminalSession): void => {
    const cell = coreOf(s.term)._renderService.dimensions.css.cell;
    if (cell.width === 0 || cell.height === 0) {
        return;
    }
    const cols = Math.max(2, Math.floor((s.host.clientWidth - SCROLLBAR_PX) / cell.width));
    const rows = Math.max(1, Math.floor(s.host.clientHeight / cell.height));
    if (cols !== s.term.cols || rows !== s.term.rows) {
        coreOf(s.term)._renderService.clear();
        s.term.resize(cols, rows);
    }
};

// (Re)build the session's fit triggers against the window its host currently lives in. A ResizeObserver — and
// the rAF that coalesces its fits (the panel's drag handle fires it per pointermove) — is per-window machinery:
// after the host is adopted into the pop-out pip document, the ORIGINAL window's observer no longer tracks it,
// so every document move rebuilds both from the host's own view. The window resize listener doubles the
// observer on purpose: a pip window's OS-level resize (Chrome restoring its remembered bounds, the user
// dragging its frame) must refit even where the observer's delivery proves unreliable; a duplicate trigger
// collapses in the rAF and a same-size fit is a no-op.
const observeHost = (s: TerminalSession): void => {
    s.unobserve?.();
    const view = s.host.ownerDocument.defaultView ?? window;
    let raf = 0;
    const schedule = (): void => {
        view.cancelAnimationFrame(raf);
        raf = view.requestAnimationFrame(() => {
            // Skip while detached (hidden host) or mid-drag at zero size — fit measures against a laid-out
            // element. A disposed session's removed host also measures 0, so a stray queued frame is inert.
            if (s.host.clientWidth === 0 || s.host.clientHeight === 0) {
                return;
            }
            fitSession(s);
        });
    };
    const observer = new view.ResizeObserver(schedule);
    observer.observe(s.host);
    view.addEventListener(`resize`, schedule);
    s.unobserve = () => {
        observer.disconnect();
        view.removeEventListener(`resize`, schedule);
    };
};

// Pre-measurement cell estimate (fontSize 13 JetBrains Mono ≈ 7.8×17 css px) for the SPAWN grid only — the
// first real fit corrects it by at most a row or two. Without it the PTY spawns at xterm's 80x24 default and
// the immediate shrink to the panel's real grid banks the difference as BLANK lines in tmux's pane history;
// every later grow (the pop-out) then resurrects them as junk rows above the prompt.
const EST_CELL_W = 7.8;
const EST_CELL_H = 17;

// Build one session's xterm + host + socket. The host stays out of the DOM until mountTerminalSession.
// `readOnly` makes it a log view (a background process's tab): stdin is disabled and keystrokes never reach
// the PTY — resize/ping still flow, tmux needs the grid to redraw. `spawnWithin` is the surface the session
// will mount into — its box sizes the PTY at birth (see EST_CELL_*).
export const createTerminalSession = (name: string, onExit: (name: string) => void, readOnly = false, spawnWithin?: HTMLElement): TerminalSession => {
    const host = document.createElement(`div`);
    host.className = `h-full w-full`;
    const term = new Terminal({
        cursorBlink: !readOnly,
        disableStdin: readOnly,
        fontFamily: `'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace`,
        fontSize: 13,
        // OSC 8 hyperlinks (CLIs that emit explicit link escapes) — without this, xterm falls back to a
        // blocking confirm() dialog on activation.
        linkHandler: { activate: openLink },
        // The wheel scrolls THIS buffer (tmux runs with mouse off), so it is the terminal's whole visible
        // history — xterm's default 1000 lines evaporate under one flooding build.
        scrollback: 10_000,
        // Snapshotted at creation; fine while --color-terminal is constant across themes/modes.
        theme: { background: getComputedStyle(document.documentElement).getPropertyValue(`--color-terminal`).trim() || `#0a0a0a` },
    });
    // tmux runs with mouse OFF, so a plain shell is mouse-native: the wheel scrolls xterm's local scrollback
    // and a drag is a plain local selection — the two compose, so a selection survives scrolling and can span
    // more than a screenful. Mouse reporting turns on only when a program INSIDE tmux requests it (vim, htop,
    // turbo's task list — tmux forwards the active pane's mouse mode to the client), and only then are plain
    // gestures ambiguous: a drag reported to the app is the app's (useless for copying in a browser), while a
    // CLICK must reach it, like VSCode's terminal. The gate below engages only in that mode and disambiguates
    // by drag distance: swallow the plain primary-button mousedown (capture phase beats xterm's screen
    // listener; preventDefault keeps the browser from blurring xterm's textarea, which xterm's own suppressed
    // handler would have done) and hold it. If the pointer wanders ≥ DRAG_PX it's a drag — replay the held
    // press with shiftKey forced, which xterm's shouldForceSelection honours: it selects locally, anchored at
    // the original press cell, and never reports to the app. If the button releases in place it's a click —
    // swallow the real mouseup too and replay press then release, so xterm runs its full pipeline (focus,
    // report press, arm its document-level release listener, report release). Replays are synthetic
    // (isTrusted false), which is what stops this gate from re-capturing them.
    const replayMouse = (event: MouseEvent, forceShift: boolean): void => {
        // The constructor reads coords, button, buttons, detail and modifiers off the source instance.
        const clone = new MouseEvent(event.type, event);
        if (forceShift) {
            Object.defineProperty(clone, `shiftKey`, { value: true });
        }
        event.target?.dispatchEvent(clone);
    };
    let pending: MouseEvent | undefined;
    host.addEventListener(
        `mousedown`,
        (event) => {
            if (
                term.modes.mouseTrackingMode === `none` ||
                !event.isTrusted ||
                event.button !== 0 ||
                event.shiftKey ||
                event.ctrlKey ||
                event.altKey ||
                event.metaKey
            ) {
                return;
            }
            // Only gate presses on the character grid — a press on the viewport's native scrollbar (or any
            // other chrome) must keep its default action, which the preventDefault below would kill.
            if (!(event.target instanceof Element) || event.target.closest(`.xterm-screen`) === null) {
                return;
            }
            event.stopImmediatePropagation();
            event.preventDefault();
            pending = event;
        },
        true,
    );
    host.addEventListener(
        `mousemove`,
        (event) => {
            if (!event.isTrusted || pending === undefined) {
                return;
            }
            // A held press whose release we never saw (it landed outside the host) — drop it on the next hover.
            if ((event.buttons & 1) === 0) {
                pending = undefined;
                return;
            }
            if (Math.abs(event.clientX - pending.clientX) < DRAG_PX && Math.abs(event.clientY - pending.clientY) < DRAG_PX) {
                return;
            }
            replayMouse(pending, true);
            pending = undefined;
        },
        true,
    );
    host.addEventListener(
        `mouseup`,
        (event) => {
            if (!event.isTrusted || pending === undefined) {
                return;
            }
            event.stopImmediatePropagation();
            const press = pending;
            pending = undefined;
            replayMouse(press, false);
            replayMouse(event, false);
        },
        true,
    );
    // Shell keybindings beat the shell-in-the-terminal: a chord bound to a registered command (Ctrl+`, the
    // terminal split/kill/new shortcuts, anything the user remapped) must reach the global dispatcher, not the
    // PTY — without this, xterm feeds tmux the raw keystroke FIRST and the command fires on top of it (VSCode
    // uses this same hook). Returning false makes xterm ignore the keydown; it still propagates to the window.
    // boundCommand honors each command's `when` gate, so a contextual chord (Mod+F's workspace search) steps
    // aside here and the raw keystroke stays with the shell.
    const isMac = isApplePlatform();
    term.attachCustomKeyEventHandler((event) => event.type !== `keydown` || boundCommand(event, isMac) === undefined);
    const serialize = new SerializeAddon();
    term.loadAddon(serialize);
    // Plain-text URLs in output (a dev server's localhost line, pnpm's changelog link, an agent's OAuth URL)
    // become Ctrl/Cmd+clickable — including the ones a program hard-wrapped across rows, which xterm's own
    // web-links addon cannot rejoin (see terminalUrlLinks).
    registerUrlLinks(term, openLink);
    // File references in output (tsc/eslint/vitest errors, node stack traces) become Ctrl/Cmd+clickable, opening
    // in the workspace editor at the referenced line. Registered after the URL provider so a URL's path tail
    // stays owned by it.
    registerFilePathLinks(term);
    // tmux runs with `set-clipboard on`, so a copy in copy-mode (`y`, …) arrives here as OSC 52
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
    if (spawnWithin !== undefined && spawnWithin.clientWidth > 0 && spawnWithin.clientHeight > 0) {
        term.resize(
            Math.max(2, Math.floor((spawnWithin.clientWidth - SCROLLBAR_PX) / EST_CELL_W)),
            Math.max(1, Math.floor(spawnWithin.clientHeight / EST_CELL_H)),
        );
    }
    const s: TerminalSession = { name, term, serialize, host, mountedDocument: document, onExit, retryDelay: RETRY_MS, closing: false, down: false };
    observeHost(s);
    // Keystrokes → pty; xterm's resize (from fitSession) → pty resize. Wired once — send() targets the current
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
// open()s it there; later mounts just move the persistent host across. `focus: false` mounts without stealing
// the keyboard — the non-focused cells of a split group.
export const mountTerminalSession = (s: TerminalSession, container: HTMLElement, focus = true): void => {
    const moved = s.mountedDocument !== container.ownerDocument;
    s.mountedDocument = container.ownerDocument;
    container.append(s.host);
    if (!s.term.element) {
        s.term.open(s.host);
        loadWebglRenderer(s.term);
    } else {
        // Idempotent re-open — xterm 6's documented cross-window move: it short-circuits to re-pointing the
        // core's window binding (char measurement, renderer scheduling, event realms) at the host's current
        // window, a no-op when nothing changed. Not keyed on `moved`: parking re-homes the binding to the main
        // realm between mounts, so even a same-document remount may need the re-point.
        s.term.open(s.host);
    }
    fitSession(s);
    if (moved) {
        observeHost(s);
        // A document move (pop-out/dock) leaves xterm's grid and tmux's screen laid out for the OLD window,
        // and the fit above may have measured mid-layout (the pip's cloned styles/fonts still settling): snap
        // the viewport back to the live screen, jiggle the PTY one row so tmux issues a full clear+redraw even
        // when the fitted size happens to match, and refit on the new window's next frame once layout is real.
        s.term.scrollToBottom();
        send(s, { type: `resize`, cols: s.term.cols, rows: Math.max(1, s.term.rows - 1) });
        s.host.ownerDocument.defaultView?.requestAnimationFrame(() => {
            if (s.host.clientWidth !== 0 && s.host.clientHeight !== 0) {
                fitSession(s);
                send(s, { type: `resize`, cols: s.term.cols, rows: s.term.rows });
            }
        });
    }
    // Unconditional resync: onResize only fires on a dimension CHANGE, so a PTY that drifted while hidden (or
    // fitted off-DOM at 80x24) would never converge otherwise. A same-size resize is a server no-op.
    send(s, { type: `resize`, cols: s.term.cols, rows: s.term.rows });
    if (focus) {
        s.term.focus();
    }
};

// Unmount a session's host WITHOUT losing it to a dying document. A host merely .remove()d while the panel
// floats stays ADOPTED by the pip document; when that window closes, the whole rendered realm dies with it —
// the WebGL context is lost inside a dead document and the fallback DOM renderer rebuilds against it, leaving
// the terminal a blank white pane. Adopting the detached host home (and re-open()ing to re-point xterm's
// window binding) keeps every hidden session anchored to the main realm. mountedDocument is deliberately NOT
// updated: the next mount must still read as a move so it rebuilds the observer and forces the tmux redraw.
export const parkTerminalSession = (s: TerminalSession): void => {
    s.host.remove();
    if (s.host.ownerDocument === document) {
        return;
    }
    s.unobserve?.();
    s.unobserve = undefined;
    document.adoptNode(s.host);
    if (s.term.element) {
        s.term.open(s.host);
    }
};

// Fully dispose one session's client state. Does NOT kill the tmux session server-side.
export const disposeTerminalSession = (s: TerminalSession): void => {
    s.closing = true;
    window.clearTimeout(s.reconnect);
    s.unobserve?.();
    s.socket?.close();
    s.term.dispose();
    s.host.remove();
};
