import { type Backoff, createBackoff } from "@intentic/base/async";
import { errorMessage } from "@intentic/base/errors";
import { SearchAddon } from "@xterm/addon-search";
import { Terminal } from "@xterm/xterm";
import { WebglAddon } from "@xterm/addon-webgl";
import { TERMINAL_PATH, type TerminalClientMessage, type TerminalServerMessage } from "@intentic/sandbox-contract/browser-wire";
import { clipboardOf, parseLoopbackLink, useDevice } from "@intentic/ui";
import { boundCommand } from "../../shell/commands/useCommands";
import { isApplePlatform } from "../../shell/commands/keybindings";
import { toScreenPx } from "../../shell/window/uiScale";
import { acquireStreamSlot } from "../sandbox/client/streamBudget";
import { transportFor } from "./channel/webTransport";
import { useEndpoint } from "../sandbox/secrets/useEndpoint";
import { useSandbox } from "../sandbox/client/useSandbox";
import { socketAddress } from "../sandbox/session/wsTicket";
import { type ChannelEvents, type TerminalChannel, socketChannel } from "./channel/terminalChannel";
import { StreamSocket } from "./channel/streamSocket";
import { editKeyBytes } from "./terminalEditKeys";
import { registerFilePathLinks } from "./terminalFileLinks";
import { registerUrlLinks } from "./terminalUrlLinks";
import { terminalPaint } from "./terminalTheme";
import { openLoopbackPreview } from "./portPreview";
import "@xterm/xterm/css/xterm.css";

// One xterm bound to one tmux session over /system/terminal, always a WebSocket: spoken on a stream of the edge's
// WebTransport session where the edge declares one and it is ready, else the browser's own. Raw frames from tmux control-mode give xterm real scrollback and search locally; every attach replays the
// pane's history and screen. Each session owns a persistent host, reconnects with backoff, and pings to catch a
// half-open channel.

const PING_MS = 30_000;
const RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;
// Debounces resize sends during a panel drag; xterm itself reflows every frame regardless.
const RESIZE_SETTLE_MS = 120;
// A connection alive this long resets the backoff on drop; shorter lives keep doubling the retry delay.
const STABLE_MS = 5000;
// Silence this long past a healthy ping cadence means half-open; close() reconnects normally.
const STALE_MS = 90_000;

const { usingLocal } = useEndpoint();
const { active } = useSandbox();

export type TerminalSession = {
    // Single-member on purpose: the agent's browser view is a separate, simpler kind of cache entry.
    readonly kind: `terminal`;
    readonly name: string;
    // Workspace-relative directory the shell starts in; the daemon honors it only when it creates the session.
    readonly cwd?: string;
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
    channel?: TerminalChannel;
    reconnect?: number;
    // Pending resize-settle timer id (scheduleResizeFrame).
    resizeSettle?: number;
    // Reconnect ladder, uptime-keyed: a connection past STABLE_MS drops back to a 1s retry.
    backoff: Backoff;
    // Set by dispose or the exit frame so the channel's close handler stops reconnecting.
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
    s.channel?.send(message);
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

// What the daemon plans the attach from: the session, its grid and its directory.
const terminalParams = (s: TerminalSession): Record<string, string> => ({
    session: s.name,
    cols: String(s.term.cols),
    rows: String(s.term.rows),
    ...(s.cwd === undefined ? {} : { cwd: s.cwd }),
});

// Whether the address terminals open on is an edge that declared WebTransport: the sandbox row says what its edge
// serves, and a loopback shortcut is no edge at all, so it declares nothing.
const webTransportDeclared = (): boolean => !usingLocal.value && (active.value?.edgeTransports ?? []).includes(`webtransport`);

// A WebSocket on a stream of the edge's WebTransport session where it is declared and ready, else the browser's own.
const openChannel = (base: string, query: string, events: ChannelEvents): TerminalChannel => {
    const transport = transportFor(base, webTransportDeclared());
    if (transport === undefined) {
        return socketChannel(new WebSocket(`${base.replace(/^http/, `ws`)}${TERMINAL_PATH}?${query}`), events);
    }
    return socketChannel(new StreamSocket(transport.createBidirectionalStream(), { host: new URL(base).host, path: TERMINAL_PATH, query }), events);
};

const scheduleRetry = (s: TerminalSession, uptimeMs = 0): void => {
    s.reconnect = window.setTimeout(() => void connectSocket(s), s.backoff.next(uptimeMs));
};

// Opens or reopens a session's channel; the daemon's replay repaints the pane on reconnect, so a reset never touches
// running processes. Runs regardless of whether the host is mounted. A one-shot ticket keeps the bearer off the query.
const connectSocket = async (s: TerminalSession): Promise<void> => {
    window.clearTimeout(s.reconnect);
    if (s.closing) {
        return;
    }
    let address: Awaited<ReturnType<typeof socketAddress>>;
    try {
        address = await socketAddress(terminalParams(s));
    } catch (error) {
        // A session that couldn't be minted (sandbox restarting, network down) retries like a drop; nothing else would.
        console.warn(`terminal ${s.name}: authorizing the socket failed`, error);
        if (s.closing) {
            return;
        }
        if (!s.down) {
            s.down = true;
            s.term.writeln(`\r\n\x1b[31mCouldn't authorize the terminal (${errorMessage(error)}); retrying.\x1b[0m`);
        }
        scheduleRetry(s);
        return;
    }
    // Disposed during the token fetch; don't resurrect a channel for a dead session.
    if (s.closing) {
        return;
    }
    if (address === undefined) {
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
    // Disposed while queuing for the permit: hand it back rather than open a channel for a dead session.
    if (s.closing) {
        release?.();
        return;
    }
    // Channel-scoped state lives in this closure, so each close clears only its own ping interval; `mine` is filled once
    // the channel exists, before anything on it can be heard.
    const mine: { channel?: TerminalChannel } = {};
    let ping: number | undefined;
    let openedAt = 0;
    let lastFrameAt = 0;
    const events: ChannelEvents = {
        open: () => {
            if (s.closing || s.channel !== mine.channel) {
                mine.channel?.close();
                return;
            }
            s.down = false;
            openedAt = Date.now();
            lastFrameAt = openedAt;
            // send() drops messages until open; push the live grid now so a mid-handshake resize isn't lost.
            send(s, { type: `resize`, cols: s.term.cols, rows: s.term.rows });
            ping = window.setInterval(() => {
                if (Date.now() - lastFrameAt > STALE_MS) {
                    mine.channel?.close();
                    return;
                }
                send(s, { type: `ping` });
            }, PING_MS);
        },
        // Any bytes from the server prove liveness, parseable or not.
        heard: () => {
            lastFrameAt = Date.now();
        },
        // Raw pane bytes; xterm decodes them, keeping a UTF-8 char split across frames whole.
        pane: (bytes) => s.term.write(bytes),
        message: (message: TerminalServerMessage) => {
            if (message.type === `exit`) {
                // Session ended; never reconnects, since `-A` would recreate it and a missing session would fail-loop.
                s.closing = true;
                s.onExit(s.name);
            }
        },
        closed: (code, reason) => {
            window.clearInterval(ping);
            // Runs before the identity guard, so every channel, including a superseded straggler, releases its permit once.
            release?.();
            if (s.channel !== mine.channel || s.closing) {
                return;
            }
            // Disconnect banner once per outage; retries stay silent, and a reattach replays over it.
            if (!s.down) {
                s.down = true;
                s.term.writeln(`\r\n\x1b[90m[disconnected (${code}${reason === `` ? `` : `: ${reason}`})]\x1b[0m`);
                s.term.writeln(`\x1b[90m[reconnecting…]\x1b[0m`);
            }
            // Uptime-keyed: a stable connection's drop retries at 1s; one that died young keeps the escalated delay.
            scheduleRetry(s, openedAt === 0 ? 0 : Date.now() - openedAt);
        },
    };
    const opened = openChannel(address.base, address.query, events);
    mine.channel = opened;
    // Supersedes any straggler channel; its close handler sees a mismatched `s.channel` and stays silent.
    s.channel?.close();
    s.channel = opened;
};

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

// Repaints a live session after a scheme or skin change. xterm holds its palette as values, not as CSS, so a session
// opened under one scheme keeps that scheme's ink until it is handed a new theme.
export const retintTerminalSession = (s: TerminalSession): void => {
    const paint = terminalPaint();
    s.term.options.theme = paint.theme;
    s.term.options.minimumContrastRatio = paint.minimumContrastRatio;
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

// Builds one session's xterm, host, and channel; the host stays out of the DOM until mountTerminalSession. `readOnly`
// makes it a log view with no stdin; `spawnWithin` sizes the attach grid.
export const createTerminalSession = (
    name: string,
    onExit: (name: string) => void,
    readOnly = false,
    spawnWithin?: HTMLElement,
    cwd?: string,
): TerminalSession => {
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
        // Palette and contrast floor, snapshotted at creation; retintTerminalSession re-reads them on a scheme or
        // skin change.
        ...terminalPaint(),
    });
    // A bound shell command takes a chord before the pane; returning false stops xterm, not propagation. What's left
    // is xterm's to encode, except the line edits it has no useful encoding for (terminalEditKeys).
    const isMac = isApplePlatform();
    term.attachCustomKeyEventHandler((event) => {
        if (event.type !== `keydown`) {
            return true;
        }
        if (boundCommand(event, isMac) !== undefined) {
            return false;
        }
        const typed = editKeyBytes(event, isMac);
        if (typed === undefined) {
            return true;
        }
        // Returning false leaves the event live, so Ctrl+Backspace would also edit xterm's own helper textarea.
        event.preventDefault();
        // wasUserInput, so the pane scrolls to the prompt and drops its selection as it would for any keystroke; a
        // read-only pane drops it, since disableStdin gates the data event.
        term.input(typed, true);
        return false;
    });
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
        ...(cwd === undefined ? {} : { cwd }),
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
    // Wires input/resize to the pane once; send() always targets the current channel, so this survives reconnects.
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
    s.channel?.close();
    detachRenderer(s);
    s.term.dispose();
    s.host.remove();
};
