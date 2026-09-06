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

/* One xterm ↔ one tmux session over the daemon's /system/terminal WebSocket, the shared core under the
 * terminal panel's tabs (useTerminal).
 *
 * xterm here IS the terminal. The daemon attaches a tmux CONTROL-MODE client to the session (its
 * terminal/tmux-control.ts) and forwards the pane's bytes raw, as binary frames, before tmux has interpreted
 * them: so this buffer holds the real scrollback, the wheel scrolls it here with nothing crossing the socket,
 * a drag is a native selection over all of it, and the search addon searches all of it. A program that wants
 * the mouse (vim, htop) asks xterm for it through that same stream and gets its reports back the same way. tmux
 * is the persistence on the far side: the session, its shell and whatever runs there outlive this socket, and
 * every attach opens with the daemon's REPLAY (a reset, then the pane's history and screen as tmux has them),
 * so a fresh xterm, after a reload, a reconnect or a sandbox switch, shows what the pane shows without anything
 * having been kept on this side.
 *
 * Each session owns a persistent host div (xterm 6 must be open()ed exactly once, so the div moves between
 * containers instead of being rebuilt), auto-reconnects a dropped socket with backoff, and pings every 30s
 * against tunnel idle-reaping. The daemon's `exit` frame (the tmux client ended: shell exited, session killed,
 * or an attach-only `panel-*` session doesn't exist) is TERMINAL, it stops reconnection and hands off to
 * `onExit`, so a dead session can't spin an attach-fail loop. */

const PING_MS = 30_000;
const RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;
// A panel drag fires a fit per frame, and every grid change is a round trip to tmux and a SIGWINCH to the shell,
// which redraws its prompt. The local xterm still reflows live; the pane learns the size once the drag settles.
const RESIZE_SETTLE_MS = 120;
// A connection that lived this long was healthy, its drop resets the backoff. Shorter lives (refused,
// accept-then-crash) keep doubling, so a broken daemon is never hammered on a tight loop.
const STABLE_MS = 5000;
// The server answers every ping with a pong, so a healthy connection ALWAYS sees a frame within PING_MS,
// silence this long means half-open; close() hands the socket to the normal reconnect path.
const STALE_MS = 90_000;

export type TerminalSession = {
    // Marks a cached pane as a terminal, and single-member on purpose: the agent's browser is NOT a session in
    // this cache. browser/useBrowserView.ts is plain reactive state over an ordinary <img>, a browser view has
    // no scrollback to preserve across an unmount, so it needs none of the persistent-host-element machinery
    // below, and that is what lets the Browsers view be a route rather than a pane in this tab machine. The one
    // thing it borrows from here is the reconnect backoff.
    readonly kind: `terminal`;
    readonly name: string;
    readonly term: Terminal;
    // Find over the whole buffer (the panel's Ctrl+F bar drives it).
    readonly search: SearchAddon;
    // Persistent xterm mount, moves in/out of containers as the surface shows/hides it.
    readonly host: HTMLElement;
    // The GPU renderer, held only while the session is on screen (attachRenderer).
    webgl?: WebglAddon;
    // Tears down the fit triggers (ResizeObserver + window resize listener) for the WINDOW the host last lived
    // in, rebuilt whenever a mount lands it somewhere new, since both are per-window machinery that stops
    // tracking an element adopted into another document.
    unobserve?: () => void;
    /* The document of the LAST mount, mountTerminalSession's move signal, and the first mount's "this is new".
     * It stays a document rather than a boolean because the app does still render into more than one (the
     * preview's iframe, the extension host's), and because getting this wrong is expensive: a host whose
     * observers belong to a document it has left refits nothing. The panel itself no longer crosses documents,
     * a floating terminal is its own window running its own copy of the app (composables/floating.ts), where
     * this session is opened fresh and the daemon replays the pane on attach. */
    mountedDocument: Document;
    // The session-over handoff: the daemon's `exit` frame, or a dispose. Never called twice. Mutable because a
    // cached session outlives the tabs instance that created it, each instance rebinds it on cache hit, so an
    // exit always updates the LIVE surface's tab state, not a destroyed one's.
    onExit: (name: string) => void;
    socket?: WebSocket;
    reconnect?: number;
    // Pending pane resize frame, the drag-settle timer (scheduleResizeFrame).
    resizeSettle?: number;
    // The reconnect ladder, uptime-keyed: a connection that lived past STABLE_MS drops back to a 1s retry.
    backoff: Backoff;
    // Set by dispose (and the exit frame) so the socket's close handler stops reconnecting.
    closing: boolean;
    // True while the connection is known-down, gates the disconnect/not-reachable banner to once per outage.
    down: boolean;
};

// Ctrl/Cmd+click opens a link (VSCode's terminal gesture), a plain click stays a click/selection gesture. The
// linkifier's mouseup is the trusted event: real modifier state, and the user activation that keeps popup
// blockers quiet. A coarse pointer has no modifier to hold and no way to select wrapped text, so there a tap IS
// the gesture, otherwise the link a phone needs most (the agent's OAuth URL) is the one it can't reach. A
// localhost link names the SANDBOX's loopback (the printing process runs inside the remote container), so it
// opens as a forwarded-port preview instead of a dead tab. Any other URI is arbitrary program output, the new
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

// Give the GPU context back. xterm reinstates its own DOM renderer as the addon disposes, so a detached
// session keeps painting, that is what makes remounting one instant.
const detachRenderer = (s: TerminalSession): void => {
    s.webgl?.dispose();
    s.webgl = undefined;
};

// Swap xterm's default DOM renderer for the GPU one, the DOM renderer repaints per cell and pegs the main
// thread under the flooding output this terminal sees (docker pulls, pnpm install, turbo/vite). Must run AFTER
// term.open() (the addon needs the canvas).
//
// Held only WHILE A SESSION IS ON SCREEN, because the addon is one WebGL2 context and a page gets about
// sixteen before the browser starts force-losing them, oldest first, which is the terminal the user has had
// open longest, i.e. the one they are working in. That terminal then draws nothing at all for the three
// seconds the addon spends waiting on a restore that is never coming for an evicted context, and every
// relayout (a panel drag reallocates each live context's drawing buffer) is what tips the page over the line.
// Scoped to the mount, the count follows what is VISIBLE, a split group, four at the very most, rather than
// every session ever opened, so the cap is never approached and a resize can't blank the screen.
//
// A context lost anyway (GPU sleep, a blocklisted driver) drops back to the DOM renderer, as does a missing
// WebGL2, which throws on load.
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
        // No WebGL2 available, xterm keeps its default DOM renderer.
    }
};

// Build the authenticated wss URL for one session, or undefined if the sandbox isn't reachable / not signed in.
// The auth half is a one-shot ticket (wsTicket.ts) so no bearer rides the query string; the URL resolves through
// the endpoint picker, so a same-machine sandbox's terminal takes loopback rather than the tunnel, keystroke
// latency is the thing a user feels most directly.
const socketUrl = (name: string, cols: number, rows: number): Promise<string | undefined> =>
    wsSocketUrl(`/system/terminal`, { session: name, cols: String(cols), rows: String(rows) });

const scheduleRetry = (s: TerminalSession, uptimeMs = 0): void => {
    s.reconnect = window.setTimeout(() => void connectSocket(s), s.backoff.next(uptimeMs));
};

// Open (or re-open) one session's socket. Reconnects reuse the xterm; the daemon's replay resets it and paints
// the pane as it is now, so the disconnect banners below go with the reset and the running processes were
// never touched. Runs whether or not the host is mounted.
const connectSocket = async (s: TerminalSession): Promise<void> => {
    window.clearTimeout(s.reconnect);
    if (s.closing) {
        return;
    }
    const url = await socketUrl(s.name, s.term.cols, s.term.rows);
    // Disposed during the token fetch, don't resurrect a socket for a dead session.
    if (s.closing) {
        return;
    }
    if (url === undefined) {
        // Usually a transient startup state (panel opened before sign-in / daemon discovery resolved), retry
        // on the same backoff as a dropped socket instead of parking the session forever.
        if (!s.down) {
            s.down = true;
            s.term.writeln(`\x1b[31mSandbox isn't reachable, or you're not signed in: finish setup and sign in with Google.\x1b[0m`);
        }
        scheduleRetry(s);
        return;
    }
    /* ONE PERMIT FOR THIS SOCKET, because it is a long-lived connection like any other and the budget's whole
     * premise is that every one of them is counted (sandbox/streamBudget.ts).
     *
     * It was not counted. `/events` and the agent attaches took permits while every open terminal quietly took
     * a seventh connection, an eighth, so on the plain-http loopback — HTTP/1.1, six per origin — two terminals
     * were enough to consume the two connections held back for ordinary requests, and the file tree, the git
     * status and the reconnect itself queued behind sockets that never end on their own. That is the same
     * client-side freeze the budget was written to prevent, reached by the one stream it did not know about.
     *
     * Terminals share the `attach` pool rather than getting one of their own: same shape of stream (one per
     * live thing the user is watching, unbounded in number, a lost one costs a reconnect and not a blind
     * window), and reusing it keeps the four-stream ceiling exactly where it already was.
     *
     * Over budget the acquire still returns — a terminal that renders nothing is worse than one that opens
     * late — and asks useEndpoint for a multiplexed transport, where the whole budget goes away. */
    const release = await acquireStreamSlot(`attach`);
    // Disposed while queueing for the permit: hand it straight back rather than opening a socket for a dead
    // session, which is the same reason the token fetch above re-checks.
    if (s.closing) {
        release?.();
        return;
    }
    const ws = new WebSocket(url);
    // The pane's bytes come as binary frames; as ArrayBuffers they go to xterm without a copy through a Blob.
    ws.binaryType = `arraybuffer`;
    // Supersede any straggler socket (its close handler sees s.socket !== ws, clears its own ping, releases its
    // own permit, and stays silent).
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
        // send() drops frames while CONNECTING, so push the live grid now, a refit during the handshake window
        // would otherwise leave the pane at its attach-time size until the next resize.
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
        // A binary frame is the pane, as its program wrote it. xterm decodes the bytes itself, which is what
        // keeps a UTF-8 character split across two frames whole.
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
            // The tmux client ended (shell exited / session killed / attach-only session missing), terminal,
            // never a reconnect: `-A` would recreate a session the user just ended, and a missing panel session
            // would fail-loop.
            s.closing = true;
            s.onExit(s.name);
        }
    });
    ws.addEventListener(`close`, (event) => {
        window.clearInterval(ping);
        /* Before the identity guard, so EVERY socket hands its permit back: a superseded straggler and a
         * disposed session both leave through the return below, and a permit released on only the surviving
         * path leaks the pool one terminal at a time until nothing can open. Releasing twice is harmless
         * (streamBudget hands out a once-only release), releasing not at all is not. */
        release?.();
        if (s.socket !== ws || s.closing) {
            return;
        }
        // Banner once per outage, the retries themselves are silent, and a successful reattach replays over it.
        if (!s.down) {
            s.down = true;
            s.term.writeln(`\r\n\x1b[90m[disconnected (${event.code}${event.reason === `` ? `` : `: ${event.reason}`})]\x1b[0m`);
            s.term.writeln(`\x1b[90m[reconnecting…]\x1b[0m`);
        }
        // Uptime-keyed: a stable connection's drop retries at 1s; one that never opened or died young keeps
        // the escalated delay.
        scheduleRetry(s, openedAt === 0 ? 0 : Date.now() - openedAt);
    });
};

// The private cell-metrics the fit needs, READ-ONLY, the same access @xterm/addon-fit makes (its own TODO
// admits it), since xterm exposes no public cell-metrics API. Nothing here drives the renderer: a fit that
// reached in to clear() before resizing was wiping the rendered screen a frame ahead of a repaint it did not
// control, which is a blank terminal for as long as the repaint is deferred (and at an idle prompt, where no
// output follows to force one, that is until the user types).
type XtermCore = { _renderService: { dimensions: { css: { cell: { width: number; height: number } } } } };
const coreOf = (term: Terminal): XtermCore => (term as unknown as { _core: XtermCore })._core;

// xterm's viewport reserves this much for its native scrollbar (ViewportConstants.DEFAULT_SCROLL_BAR_WIDTH).
const SCROLLBAR_PX = 14;

// Fit the grid to the host's box, measured in the HOST'S OWN realm (clientWidth/Height). Not @xterm/addon-fit:
// its proposeDimensions measures through the GLOBAL window's getComputedStyle, which is cross-realm for a host
// living in any other document (an iframe's), where it can silently misresolve, no-oping every fit and leaving
// the pane at a grid the panel no longer has.
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

// Hand the settled grid to the pane. Debounced because the fit runs per frame of a panel drag and each frame's
// resize is a round trip and a prompt redraw, one drag used to be dozens of them. xterm reflows locally on
// every step regardless, so the panel still tracks the pointer; only the pane waits.
const scheduleResizeFrame = (s: TerminalSession): void => {
    window.clearTimeout(s.resizeSettle);
    s.resizeSettle = window.setTimeout(() => {
        s.resizeSettle = undefined;
        send(s, { type: `resize`, cols: s.term.cols, rows: s.term.rows });
    }, RESIZE_SETTLE_MS);
};

// (Re)build the session's fit triggers against the window its host currently lives in. A ResizeObserver, and
// the rAF that coalesces its fits (the panel's drag handle fires it per pointermove), is per-window machinery
// that stops tracking an element adopted into another document, so both are rebuilt from the host's own view on
// every move. The window resize listener doubles the observer on purpose: an OS-level window resize (the reader
// maximizing a floating terminal, or dragging its frame) must refit even where the observer's delivery proves
// unreliable; a duplicate trigger collapses in the rAF and a same-size fit is a no-op.
const observeHost = (s: TerminalSession): void => {
    s.unobserve?.();
    const view = s.host.ownerDocument.defaultView ?? window;
    let raf = 0;
    const schedule = (): void => {
        view.cancelAnimationFrame(raf);
        raf = view.requestAnimationFrame(() => {
            // Skip while detached (hidden host) or mid-drag at zero size, fit measures against a laid-out
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

// The terminal's type, stated at the app's base text size and converted on use, xterm paints its own glyphs
// from a number, so it is one of the few things CSS does not carry along when that size changes.
const FONT_PX = 12;

// Pre-measurement cell estimate (fontSize 12 JetBrains Mono ≈ 7.2×16 css px) for the ATTACH grid only, the
// first real fit corrects it by at most a row or two. Without it the pane is attached at xterm's 80x24 default
// and the daemon's opening replay is captured at that width, wrapped for a grid the panel does not have, and
// the immediate shrink to the real one then reflows it once more in front of the user. Scaled with the font it
// is an estimate OF, or the guess is wrong by the text size on every attach.
const EST_CELL_W = 7.2;
const EST_CELL_H = 16;
const estCell = (): { width: number; height: number } => {
    const factor = toScreenPx(FONT_PX) / FONT_PX;
    return { width: EST_CELL_W * factor, height: EST_CELL_H * factor };
};

// Re-type a LIVE session after the app's text size changed. A terminal's font size is a number it was built
// with, so an open shell would otherwise keep yesterday's type until it was killed and reopened, and because
// the glyphs change size, the grid that fits the same box changes with them: refit, then tell the pane, or the
// shell keeps drawing for a grid that is no longer that many columns wide.
export const retypeTerminalSession = (s: TerminalSession): void => {
    const size = toScreenPx(FONT_PX);
    if (s.term.options.fontSize === size) {
        return;
    }
    s.term.options.fontSize = size;
    fitSession(s);
    scheduleResizeFrame(s);
};

// The two clipboard verbs, both routed through the TERMINAL's own window (clipboardOf) for the same reason the
// OSC 52 handler is: in an iframe or a second surface, this realm's document may be the unfocused one, and
// Chrome refuses a clipboard call from it. A denied read (no permission, or a browser that only exposes the
// clipboard through a real paste event) leaves the terminal untouched. Ctrl+V, which arrives as that event,
// always works.
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
            // The paste came from the context menu, whose click took the keyboard: hand it back, so the
            // cursor sits right after the pasted text instead of the next keystroke landing nowhere.
            s.term.focus();
        })
        .catch(() => {});
};

// Build one session's xterm + host + socket. The host stays out of the DOM until mountTerminalSession.
// `readOnly` makes it a log view (a background process's tab): stdin is disabled and keystrokes never reach
// the pane, resize/ping still flow. `spawnWithin` is the surface the session will mount into, its box sizes the
// pane at attach (see EST_CELL_*).
export const createTerminalSession = (name: string, onExit: (name: string) => void, readOnly = false, spawnWithin?: HTMLElement): TerminalSession => {
    const host = document.createElement(`div`);
    host.className = `h-full w-full`;
    const term = new Terminal({
        // The search addon paints its matches with xterm's decoration API, which xterm still files under
        // "proposed" and refuses (throws, on the first keystroke into the find bar) unless this is on.
        allowProposedApi: true,
        cursorBlink: !readOnly,
        disableStdin: readOnly,
        fontFamily: `'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace`,
        fontSize: toScreenPx(FONT_PX),
        // OSC 8 hyperlinks (CLIs that emit explicit link escapes), without this, xterm falls back to a
        // blocking confirm() dialog on activation.
        linkHandler: { activate: openLink },
        // THE scrollback, the one the wheel moves through: the daemon's attach replay seeds it with the pane's
        // history (a few thousand lines, tmux-control.ts says how many) and live output grows it from there.
        // Deeper than the replay so a long build's output stays reachable without a reattach.
        scrollback: 30_000,
        // A right-click on a word with nothing selected selects the word, so the context menu's Copy has
        // something to copy: the gesture VSCode's terminal has.
        rightClickSelectsWord: true,
        // Snapshotted at creation; fine while --color-terminal is constant across themes/modes.
        theme: { background: getComputedStyle(document.documentElement).getPropertyValue(`--color-terminal`).trim() || `#0a0a0a` },
    });
    // Shell keybindings beat the shell-in-the-terminal: a chord bound to a registered command (Ctrl+`, the
    // terminal split/kill/new shortcuts, anything the user remapped) must reach the global dispatcher, not the
    // pane, without this, xterm feeds the shell the raw keystroke FIRST and the command fires on top of it
    // (VSCode uses this same hook). Returning false makes xterm ignore the keydown; it still propagates to the
    // window. boundCommand honors each command's `when` gate, so a contextual chord (the terminal panel's own
    // commands, gated on this panel having focus) steps aside here and the raw keystroke stays with the shell.
    const isMac = isApplePlatform();
    term.attachCustomKeyEventHandler((event) => event.type !== `keydown` || boundCommand(event, isMac) === undefined);
    const search = new SearchAddon();
    term.loadAddon(search);
    // Plain-text URLs in output (a dev server's localhost line, pnpm's changelog link, an agent's OAuth URL)
    // become Ctrl/Cmd+clickable, including the ones a program hard-wrapped across rows, which xterm's own
    // web-links addon cannot rejoin (see terminalUrlLinks).
    registerUrlLinks(term, openLink);
    // File references in output (tsc/eslint/vitest errors, node stack traces) become Ctrl/Cmd+clickable, opening
    // in the workspace editor at the referenced line. Registered after the URL provider so a URL's path tail
    // stays owned by it.
    registerFilePathLinks(term);
    // A program's own copy, OSC 52 with a base64 payload (a CLI's "copied to clipboard", an editor's yank),
    // reaches xterm raw and would otherwise be ignored: land it in the browser clipboard. `?` asks to READ the
    // clipboard; that stays unanswered. Guarded: the payload is arbitrary program output. The write goes through
    // the TERMINAL's own window (clipboardOf): elsewhere, this realm's document is the unfocused one behind, and
    // Chrome refuses a clipboard write from it.
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
            // not valid base64, drop it rather than kill the parser
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
    // Keystrokes → pane; xterm's resize (from fitSession) → pane resize. Wired once, send() targets the current
    // socket, so these survive reconnects. A read-only session wires no input path at all (disableStdin already
    // drops keystrokes; this also covers programmatic term.input, e.g. the touch extra-keys row).
    if (!readOnly) {
        term.onData((data) => send(s, { type: `input`, data }));
    }
    term.onResize(() => scheduleResizeFrame(s));
    // COPY ON SELECT, at the end of the gesture. A primary-button press on the grid arms one mouseup listener on
    // the document (xterm's own selection ends there too, a drag that leaves the host still finishes), and
    // whatever is selected when the button comes up is copied: a drag, a double-clicked word, a triple-clicked
    // line. The mouseup is what makes it work at all, a clipboard write needs the transient user activation a
    // pointer event carries. Not onSelectionChange: xterm fires that when arriving output re-lays a selection
    // too, and copying those silently overwrote whatever the user had on their clipboard from elsewhere.
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
    // Connect immediately, even before the host is mounted: a hidden session keeps streaming. xterm buffers
    // writes made before open(), so the replay and whatever follows accrue until the first mount open()s the
    // renderer and fit() sends the real size.
    void connectSocket(s);
    return s;
};

// Mount a session into a container: xterm must be open()ed against an in-DOM element, so the first mount
// open()s it there; later mounts just move the persistent host across. `focus: false` mounts without stealing
// the keyboard, the non-focused cells of a split group.
export const mountTerminalSession = (s: TerminalSession, container: HTMLElement, focus = true): void => {
    const moved = s.mountedDocument !== container.ownerDocument;
    s.mountedDocument = container.ownerDocument;
    container.append(s.host);
    // Idempotent: the first call builds xterm against the host, and every later one is xterm 6's documented
    // cross-window move, it short-circuits to re-pointing the core's window binding (char measurement,
    // renderer scheduling, event realms) at the host's current window, a no-op when nothing changed. Not keyed
    // on `moved`: parking re-homes the binding to the main realm between mounts, so even a same-document
    // remount may need the re-point. The GPU renderer is built AFTER it, against the window that just won.
    s.term.open(s.host);
    attachRenderer(s);
    fitSession(s);
    if (moved) {
        observeHost(s);
        // A move leaves xterm's grid laid out for wherever the host was, and the fit above may have measured
        // mid-layout: snap the viewport back to the live screen and refit on the next frame once layout is real.
        // xterm's own buffer is the picture, so nothing needs redrawing from the far side.
        s.term.scrollToBottom();
        s.host.ownerDocument.defaultView?.requestAnimationFrame(() => {
            if (s.host.clientWidth !== 0 && s.host.clientHeight !== 0) {
                fitSession(s);
                send(s, { type: `resize`, cols: s.term.cols, rows: s.term.rows });
            }
        });
    }
    // Unconditional resync: onResize only fires on a dimension CHANGE, so a pane that drifted while hidden (or
    // fitted off-DOM at 80x24) would never converge otherwise. A same-size resize is a server no-op.
    send(s, { type: `resize`, cols: s.term.cols, rows: s.term.rows });
    if (focus) {
        s.term.focus();
    }
};

// Unmount a session's host WITHOUT losing it to a document that may go away. A host merely .remove()d stays
// ADOPTED by whatever document last held it, and if that document dies the WebGL context is lost inside it and
// the fallback DOM renderer rebuilds against it, leaving the terminal a blank white pane. Adopting the detached
// host into THIS document (and re-open()ing to re-point xterm's window binding) keeps every hidden session
// anchored where its realm is. mountedDocument is deliberately NOT updated: the next mount must still read as a
// move so it rebuilds the observer.
export const parkTerminalSession = (s: TerminalSession): void => {
    // The GPU context goes back to the browser the moment a session leaves the screen (see attachRenderer),
    // which also means the context above never survives to be carried into another document at all: the next
    // mount builds a fresh one against whichever window won.
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

// Fully dispose one session's client state. Does NOT kill the tmux session server-side.
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
