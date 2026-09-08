import { type Backoff, createBackoff } from "@intentic/base/async";
import { SearchAddon } from "@xterm/addon-search";
import { Terminal } from "@xterm/xterm";
import { WebglAddon } from "@xterm/addon-webgl";
import type { TerminalClientMessage, TerminalServerMessage } from "@intentic/sandbox-contract";
import { clipboardOf, parseLoopbackLink, useDevice } from "@intentic/ui";
import { boundCommand } from "../../shell/commands/useCommands";
import { isApplePlatform } from "../../shell/commands/keybindings";
import { toScreenPx } from "../../shell/window/uiScale";
import { acquireStreamSlot } from "../sandbox/client/streamBudget";
import { socketUrl as wsSocketUrl } from "../sandbox/client/wsTicket";
import { registerFilePathLinks } from "./terminalFileLinks";
import { registerUrlLinks } from "./terminalUrlLinks";
import { openLoopbackPreview } from "./portPreview";
import "@xterm/xterm/css/xterm.css";

// One xterm bound to one tmux session over the daemon's /system/terminal WebSocket. Raw frames from tmux control-mode
// give xterm real scrollback and search locally; every attach replays the pane's history and screen. Each session owns
// a persistent host, reconnects with backoff, and pings to catch a half-open socket.

const PING_MS = 30_000;
const RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;
// Debounces resize sends during a panel drag; xterm itself reflows every frame regardless.
const RESIZE_SETTLE_MS = 120;
// A connection alive this long resets the backoff on drop; shorter lives keep doubling the retry delay.
const STABLE_MS = 5000;
// Silence this long past a healthy ping cadence means half-open; close() reconnects normally.
const STALE_MS = 90_000;

export type TerminalSession = {
    // Single-member on purpose: the agent's browser view is a separate, simpler kind of cache entry.
    readonly kind: `terminal`;
    readonly name: string;
    readonly term: Terminal;
    // Search addon; the panel's Ctrl+F bar searches the buffer through this.
    readonly search: SearchAddon;
    // Persistent xterm mount; moves between containers as the surface shows or hides it.
    readonly host: HTMLElement;
    // GPU renderer, present only while the session is on screen (attachRenderer).
    webgl?: WebglAddon;
    // Tears down the host's fit observers for its current window; rebuilt on every mount into a new one.
    unobserve?: () => void;
    // Document of the last mount; a change signals mountTerminalSession to rebuild window-scoped fit machinery.
    mountedDocument: Document;
    // Session-over handoff (exit frame or dispose), called once; rebound per tabs instance on cache hit.
    onExit: (name: string) => void;
    socket?: WebSocket;
    reconnect?: number;
    // Pending resize-settle timer id (scheduleResizeFrame).
    resizeSettle?: number;
    // Reconnect ladder, uptime-keyed: a connection past STABLE_MS drops back to a 1s retry.
    backoff: Backoff;
    // Set by dispose or the exit frame so the socket's close handler stops reconnecting.
    closing: boolean;
    // True while the connection is known down; gates the disconnect banner to once per outage.
    down: boolean;
};

// Ctrl/Cmd+click (or any tap on a coarse pointer) opens a link, from the linkifier's trusted mouseup. A sandbox
// loopback URL opens as a port preview instead of a dead tab; anything else opens with no opener.
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

// Releases the GPU context; xterm's DOM renderer takes back over, so a detached session keeps painting.
const detachRenderer = (s: TerminalSession): void => {
    s.webgl?.dispose();
    s.webgl = undefined;
};

// Swaps xterm's DOM renderer for WebGL so heavy output doesn't peg the main thread. Held only while on screen, since a
// page gets a small, fixed budget of WebGL2 contexts; falls back to DOM on context loss or a missing WebGL2.
const attachRenderer = (s: TerminalSession): void => {
    if (s.webgl !== undefined) {
        return;
    }
    try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => detachRenderer(s));
        s.term.loadAddon(webgl);
        s.webgl = webgl;
    } catch {
        // No WebGL2 available; xterm keeps its default DOM renderer.
    }
};

// Authenticated wss URL for one session, or undefined if unreachable or signed out. A one-shot ticket keeps the bearer
// off the query string, and the endpoint picker prefers loopback on a same-machine sandbox.
const socketUrl = (name: string, cols: number, rows: number): Promise<string | undefined> =>
    wsSocketUrl(`/system/terminal`, { session: name, cols: String(cols), rows: String(rows) });

const scheduleRetry = (s: TerminalSession, uptimeMs = 0): void => {
    s.reconnect = window.setTimeout(() => void connectSocket(s), s.backoff.next(uptimeMs));
};

// Opens or reopens a session's socket; the daemon's replay repaints the pane on reconnect, so a reset never touches
// running processes. Runs regardless of whether the host is mounted.
const connectSocket = async (s: TerminalSession): Promise<void> => {
    window.clearTimeout(s.reconnect);
    if (s.closing) {
        return;
    }
    const url = await socketUrl(s.name, s.term.cols, s.term.rows);
    // Disposed during the token fetch; don't resurrect a socket for a dead session.
    if (s.closing) {
        return;
    }
    if (url === undefined) {
        // Usually a transient startup state; retries on the normal backoff instead of parking the session forever.
        if (!s.down) {
            s.down = true;
            s.term.writeln(`\x1b[31mSandbox isn't reachable, or you're not signed in: finish setup and sign in with Google.\x1b[0m`);
        }
        scheduleRetry(s);
        return;
    }
    // Counted against the shared `attach` stream budget; over budget it still connects, via a multiplexed transport.
    const release = await acquireStreamSlot(`attach`);
    // Disposed while queuing for the permit: hand it back rather than open a socket for a dead session.
    if (s.closing) {
        release?.();
        return;
    }
    const ws = new WebSocket(url);
    // Binary frames arrive as ArrayBuffers, straight to xterm with no Blob copy.
    ws.binaryType = `arraybuffer`;
    // Supersedes any straggler socket; its close handler sees a mismatched `s.socket` and stays silent.
    s.socket?.close();
    s.socket = ws;
    // Socket-scoped state lives in this closure, so each close event clears only its own ping interval.
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
        // send() drops frames while CONNECTING; push the live grid now so a mid-handshake resize isn't lost.
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
        // Binary frame is raw pane bytes; xterm decodes it, keeping a UTF-8 char split across frames whole.
        if (event.data instanceof ArrayBuffer) {
            s.term.write(new Uint8Array(event.data));
            return;
        }
        let message: TerminalServerMessage;
        try {
            message = JSON.parse(String(event.data)) as TerminalServerMessage;
        } catch {
            return;
        }
        if (message.type === `exit`) {
            // Session ended; never reconnects, since `-A` would recreate it and a missing session would fail-loop.
            s.closing = true;
            s.onExit(s.name);
        }
    });
    ws.addEventListener(`close`, (event) => {
        window.clearInterval(ping);
        // Runs before the identity guard, so every socket, including a superseded straggler, releases its permit once.
        release?.();
        if (s.socket !== ws || s.closing) {
            return;
        }
        // Disconnect banner once per outage; retries stay silent, and a reattach replays over it.
        if (!s.down) {
            s.down = true;
            s.term.writeln(`\r\n\x1b[90m[disconnected (${event.code}${event.reason === `` ? `` : `: ${event.reason}`})]\x1b[0m`);
            s.term.writeln(`\x1b[90m[reconnecting…]\x1b[0m`);
        }
        // Uptime-keyed: a stable connection's drop retries at 1s; one that died young keeps the escalated delay.
        scheduleRetry(s, openedAt === 0 ? 0 : Date.now() - openedAt);
    });
};

// The private cell-metrics the fit needs, READ-ONLY, the same access @xterm/addon-fit makes (its own TODO
// Private cell metrics the fit reads, since xterm exposes no public API for them; read-only, never used to mutate the
// renderer.
type XtermCore = { _renderService: { dimensions: { css: { cell: { width: number; height: number } } } } };
const coreOf = (term: Terminal): XtermCore => (term as unknown as { _core: XtermCore })._core;

// xterm's viewport reserves this much width for its native scrollbar.
const SCROLLBAR_PX = 14;

// Fits the grid to the host's box using its own realm's clientWidth/Height, not @xterm/addon-fit, whose cross-realm
// measurement can silently no-op in another document (an iframe's).
const fitSession = (s: TerminalSession): void => {
    const cell = coreOf(s.term)._renderService.dimensions.css.cell;
    if (cell.width === 0 || cell.height === 0) {
        return;
    }
    const cols = Math.max(2, Math.floor((s.host.clientWidth - SCROLLBAR_PX) / cell.width));
    const rows = Math.max(1, Math.floor(s.host.clientHeight / cell.height));
    if (cols !== s.term.cols || rows !== s.term.rows) {
        s.term.resize(cols, rows);
    }
};

// Debounces the resize send to the pane; xterm itself reflows immediately on every frame.
const scheduleResizeFrame = (s: TerminalSession): void => {
    window.clearTimeout(s.resizeSettle);
    s.resizeSettle = window.setTimeout(() => {
        s.resizeSettle = undefined;
        send(s, { type: `resize`, cols: s.term.cols, rows: s.term.rows });
    }, RESIZE_SETTLE_MS);
};

// (Re)builds fit triggers against the host's current window: a ResizeObserver plus a window resize listener, since both
// stop tracking an element moved to another document. The listener also catches OS-level resizes the observer may miss.
const observeHost = (s: TerminalSession): void => {
    s.unobserve?.();
    const view = s.host.ownerDocument.defaultView ?? window;
    let raf = 0;
    const schedule = (): void => {
        view.cancelAnimationFrame(raf);
        raf = view.requestAnimationFrame(() => {
            // Skips while detached or mid-drag at zero size; a disposed session's removed host also measures zero.
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

// Base terminal font size; xterm paints its own glyphs, so CSS text-size changes don't scale it.
const FONT_PX = 12;

// Pre-measured cell size (JetBrains Mono, 12px) for the attach grid only; the first fit corrects any drift.
const EST_CELL_W = 7.2;
const EST_CELL_H = 16;
const estCell = (): { width: number; height: number } => {
    const factor = toScreenPx(FONT_PX) / FONT_PX;
    return { width: EST_CELL_W * factor, height: EST_CELL_H * factor };
};

// Re-types a live session after the app's text size changes, then refits and resends the grid so the shell doesn't keep
// drawing for a stale column count.
export const retypeTerminalSession = (s: TerminalSession): void => {
    const size = toScreenPx(FONT_PX);
    if (s.term.options.fontSize === size) {
        return;
    }
    s.term.options.fontSize = size;
    fitSession(s);
    scheduleResizeFrame(s);
};

// Both clipboard verbs route through the terminal's own window: elsewhere this realm's document may be unfocused and
// Chrome refuses the call. A denied read just leaves the terminal untouched; Ctrl+V (a real paste event) still works.
export const copySelection = (s: TerminalSession): void => {
    const selection = s.term.getSelection();
    if (selection === ``) {
        return;
    }
    void clipboardOf(s.term.element)
        .writeText(selection)
        .catch(() => {});
};

export const pasteIntoTerminal = (s: TerminalSession): void => {
    void clipboardOf(s.term.element)
        .readText()
        .then((text) => {
            s.term.paste(text);
            // Context menu's click took focus; hand it back so the cursor lands after the pasted text.
            s.term.focus();
        })
        .catch(() => {});
};

// Builds one session's xterm, host, and socket; the host stays out of the DOM until mountTerminalSession. `readOnly`
// makes it a log view with no stdin; `spawnWithin` sizes the attach grid.
export const createTerminalSession = (name: string, onExit: (name: string) => void, readOnly = false, spawnWithin?: HTMLElement): TerminalSession => {
    const host = document.createElement(`div`);
    host.className = `h-full w-full`;
    const term = new Terminal({
        // Needed for the search addon's match decorations, which xterm gates behind this flag.
        allowProposedApi: true,
        cursorBlink: !readOnly,
        disableStdin: readOnly,
        fontFamily: `'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace`,
        fontSize: toScreenPx(FONT_PX),
        // OSC 8 hyperlink support; without it xterm falls back to a blocking confirm() dialog.
        linkHandler: { activate: openLink },
        // Scrollback depth; deeper than the daemon's replay so long output stays reachable without reattaching.
        scrollback: 30_000,
        // Right-click on a bare word selects it first, so the context menu's Copy has something to copy.
        rightClickSelectsWord: true,
        // Snapshotted at creation; fine while --color-terminal is constant across themes.
        theme: { background: getComputedStyle(document.documentElement).getPropertyValue(`--color-terminal`).trim() || `#0a0a0a` },
    });
    // A bound shell command takes a chord before the pane; returning false stops xterm, not propagation.
    const isMac = isApplePlatform();
    term.attachCustomKeyEventHandler((event) => event.type !== `keydown` || boundCommand(event, isMac) === undefined);
    const search = new SearchAddon();
    term.loadAddon(search);
    // Makes plain-text URLs Ctrl/Cmd-clickable, including ones a program hard-wrapped across rows.
    registerUrlLinks(term, openLink);
    // Makes file references Ctrl/Cmd-clickable, opening the editor at that line; registered after the URL provider.
    registerFilePathLinks(term);
    // OSC 52 forwards a clipboard copy to the browser via the terminal's window; reads go unanswered.
    term.parser.registerOscHandler(52, (data) => {
        const payload = data.slice(data.indexOf(`;`) + 1);
        if (payload === `?`) {
            return true;
        }
        try {
            void clipboardOf(term.element)
                .writeText(new TextDecoder().decode(Uint8Array.from(atob(payload), (c) => c.charCodeAt(0))))
                .catch(() => {});
        } catch {
            // Not valid base64; drop it rather than kill the parser.
        }
        return true;
    });
    if (spawnWithin !== undefined && spawnWithin.clientWidth > 0 && spawnWithin.clientHeight > 0) {
        const cell = estCell();
        term.resize(
            Math.max(2, Math.floor((spawnWithin.clientWidth - SCROLLBAR_PX) / cell.width)),
            Math.max(1, Math.floor(spawnWithin.clientHeight / cell.height)),
        );
    }
    const s: TerminalSession = {
        kind: `terminal`,
        name,
        term,
        search,
        host,
        mountedDocument: document,
        onExit,
        backoff: createBackoff({ floorMs: RETRY_MS, capMs: MAX_RETRY_MS, stableMs: STABLE_MS }),
        closing: false,
        down: false,
    };
    observeHost(s);
    // Wires input/resize to the pane once; send() always targets the current socket, so this survives reconnects.
    if (!readOnly) {
        term.onData((data) => send(s, { type: `input`, data }));
    }
    term.onResize(() => scheduleResizeFrame(s));
    // Copies on mouseup after a selection gesture; onSelectionChange also fires when output re-lays one.
    host.addEventListener(
        `mousedown`,
        (event) => {
            if (event.button !== 0 || !(event.target instanceof Element) || event.target.closest(`.xterm-screen`) === null) {
                return;
            }
            host.ownerDocument.addEventListener(
                `mouseup`,
                () => {
                    if (term.hasSelection()) {
                        copySelection(s);
                    }
                },
                { once: true },
            );
        },
        true,
    );
    // Connects immediately even unmounted; xterm buffers pre-open() writes so nothing is lost before mount.
    void connectSocket(s);
    return s;
};

// Mounts a session into a container; the first mount open()s xterm against it, later mounts just move the host. `focus:
// false` mounts without stealing the keyboard.
export const mountTerminalSession = (s: TerminalSession, container: HTMLElement, focus = true): void => {
    const moved = s.mountedDocument !== container.ownerDocument;
    s.mountedDocument = container.ownerDocument;
    container.append(s.host);
    // Idempotent: first call builds xterm, later calls just re-point its window binding; else a no-op.
    s.term.open(s.host);
    attachRenderer(s);
    fitSession(s);
    if (moved) {
        observeHost(s);
        // A move can leave the grid laid out mid-transition; snap to bottom and refit once layout settles.
        s.term.scrollToBottom();
        s.host.ownerDocument.defaultView?.requestAnimationFrame(() => {
            if (s.host.clientWidth !== 0 && s.host.clientHeight !== 0) {
                fitSession(s);
                send(s, { type: `resize`, cols: s.term.cols, rows: s.term.rows });
            }
        });
    }
    // Unconditional resync: onResize fires only on a dimension change, so a hidden pane's drift needs telling.
    send(s, { type: `resize`, cols: s.term.cols, rows: s.term.rows });
    if (focus) {
        s.term.focus();
    }
};

// Unmounts a host without losing it to a dying document, which would blank the pane. Adopts it into this document
// instead; mountedDocument stays stale so the next mount rebuilds its observer.
export const parkTerminalSession = (s: TerminalSession): void => {
    // GPU context returns to the browser once the session leaves the screen; the next mount builds a fresh one.
    detachRenderer(s);
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

// Fully disposes one session's client state; does not kill the tmux session server-side.
export const disposeTerminalSession = (s: TerminalSession): void => {
    s.closing = true;
    window.clearTimeout(s.reconnect);
    window.clearTimeout(s.resizeSettle);
    s.unobserve?.();
    s.socket?.close();
    detachRenderer(s);
    s.term.dispose();
    s.host.remove();
};
