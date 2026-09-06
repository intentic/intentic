import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

/* THE BROWSER'S TMUX CLIENT IS A CONTROL-MODE CLIENT, and this is the whole of what that takes.
 *
 * A normal `tmux attach` is a screen: tmux draws the pane onto the alternate screen of whatever terminal it is
 * attached from, and owns everything about that picture: the wheel (mouse mode, remote copy-mode, its own
 * `[12/3400]` position tag), the scrollback (tmux's, on the far side of the socket, never in the browser), and
 * a selection (tmux's, not the browser's). Rendered into xterm.js, that made a browser terminal that could
 * neither scroll nor copy nor search like a local one, because xterm was only ever shown one screenful.
 *
 * `tmux -C` is the other client tmux has. It draws nothing. It speaks a line protocol on stdout: every byte a
 * pane's program writes arrives as a `%output %<pane> <escaped>` notification, RAW, before tmux has interpreted
 * it, and everything tmux would tell a screen about the session (windows added, the active one changing) is a
 * `%…` line too. Commands go in on stdin, one per line, each answered by exactly one `%begin`/`%end` (or
 * `%error`) block. It is what iTerm2's tmux integration is built on, and it turns the roles the right way
 * round: xterm in the browser IS the terminal, with its own scrollback, selection and search over the whole
 * buffer, and the wheel and a drag never leave the page; tmux is the thing that keeps the shell alive between
 * attaches, lists it, logs it, and hands its history back on the next attach.
 *
 * Three things follow from "raw":
 *   · A program that wants the mouse (vim, htop) asks xterm for it directly, its `?1000h` rides the stream, and
 *     xterm reports back into the pane through send-keys below. tmux's own mouse mode is off (the image's
 *     tmux.conf), nothing here needs it.
 *   · Keystrokes are injected into the PANE (`send-keys -H`, literal bytes), never fed to tmux as keys, so the
 *     prefix key and every tmux binding are simply not reachable from a tab. The panel does its own splits.
 *   · On attach xterm holds nothing, so the pane's history is read back (`capture-pane -e -J`, colour kept,
 *     wrapped lines rejoined so xterm re-wraps them at its own width) and written as the buffer's opening
 *     bytes, then the cursor and the pane's modes are re-stated from tmux's formats (a reattach into a running
 *     vim lands on its alternate screen with the mouse on, as it should). The same replay is the answer to a
 *     browser that fell behind: drop, let it drain, replay (terminal.ts).
 *
 * Two layers here, both without a tty. `createControlParser` is the wire (pure, tested on its own); the client
 * over it owns one child process and one FIFO of command replies; `attachControlTerminal` is the thing a
 * WebSocket wants: follow the session's active pane, keep it in sync, take bytes in and hand bytes out.
 */

// ------------------------------------------------------------------------------------------------------------
// The wire.

export type ControlEvent =
    // A pane wrote these bytes. Already unescaped; UTF-8 is NOT decoded here, a chunk boundary can split a
    // character, and xterm's own decoder is the one that has to see the halves in order.
    | { readonly kind: "output"; readonly pane: string; readonly bytes: Buffer }
    // One command's answer. `initial` is the block tmux emits for the command the client was STARTED with (the
    // attach itself), which nobody here asked for: it is flagged 0 where every command sent later is flagged 1.
    | { readonly kind: "reply"; readonly ok: boolean; readonly initial: boolean; readonly lines: readonly string[] }
    // Any other `%…` line: `%session-changed $1 name`, `%session-window-changed $1 @3`, `%window-pane-changed`…
    | { readonly kind: "notice"; readonly name: string; readonly args: string }
    // The client is ending: the session was destroyed, or an empty line detached it.
    | { readonly kind: "exit"; readonly reason: string };

export interface ControlParser {
    // Feed the child's stdout as it arrives; partial lines are held across calls.
    readonly feed: (chunk: Buffer) => ControlEvent[];
}

// `-CC` prefixes the very first line with this DCS so a terminal knows control mode began; `-C` does not, but
// the parser strips it either way rather than depend on which flag spawned it.
const DCS_PREFIX = "\x1bP1000p";

const NEWLINE = 0x0a;

// `%output`'s escaping is one rule: every byte below 0x20 and the backslash itself become `\ooo` octal, and
// every other byte, including all of UTF-8's upper range, is passed as itself. The line is handled as LATIN1 so
// that one char is one byte throughout; the result is bytes, and stays bytes.
export const decodeOutput = (value: string): Buffer => {
    const out = Buffer.allocUnsafe(value.length);
    let length = 0;
    for (let i = 0; i < value.length; i++) {
        const c = value.charCodeAt(i);
        if (c === 0x5c && isOctal(value, i + 1)) {
            out[length++] = Number.parseInt(value.slice(i + 1, i + 4), 8) & 0xff;
            i += 3;
        } else {
            out[length++] = c & 0xff;
        }
    }
    return out.subarray(0, length);
};

const isOctal = (value: string, at: number): boolean => {
    if (at + 3 > value.length) {
        return false;
    }
    for (let i = at; i < at + 3; i++) {
        const c = value.charCodeAt(i);
        if (c < 0x30 || c > 0x37) {
            return false;
        }
    }
    return true;
};

// `%begin 1788688249 476510 0` → the stamp tmux repeats on the matching `%end`/`%error`, and the flag.
const BLOCK_LINE = /^%(begin|end|error) (\d+ \d+) (\d+)$/;

interface BlockLine {
    readonly verb: "begin" | "end" | "error";
    readonly stamp: string;
    readonly initial: boolean;
}

const parseBlockLine = (text: string): BlockLine | undefined => {
    const match = BLOCK_LINE.exec(text);
    if (match === null || match[1] === undefined || match[2] === undefined) {
        return undefined;
    }
    return { verb: match[1] as BlockLine["verb"], stamp: match[2], initial: match[3] === "0" };
};

// A `%…` line outside any block: pane output, the exit, or one of tmux's state notices.
const parseNotification = (text: string): ControlEvent => {
    const space = text.indexOf(" ");
    const name = space === -1 ? text.slice(1) : text.slice(1, space);
    const args = space === -1 ? "" : text.slice(space + 1);
    if (name === "output") {
        const gap = args.indexOf(" ");
        // `%output %5 ` with an EMPTY payload is a real line (a pane wrote nothing decodable); still a pane.
        const pane = gap === -1 ? args : args.slice(0, gap);
        return { kind: "output", pane, bytes: decodeOutput(gap === -1 ? "" : args.slice(gap + 1)) };
    }
    if (name === "exit") {
        return { kind: "exit", reason: args };
    }
    return { kind: "notice", name, args };
};

export const createControlParser = (): ControlParser => {
    let rest: Buffer = Buffer.alloc(0);
    let block: { readonly stamp: string; readonly initial: boolean; readonly lines: string[] } | undefined;

    // Inside a block only its OWN terminator ends it: the stamp is what keeps a pane line that happens to read
    // `%end …` (a capture of someone else's control-mode transcript, say) from closing it early.
    const inBlock = (open: NonNullable<typeof block>, text: string): ControlEvent | undefined => {
        const line = parseBlockLine(text);
        if (line !== undefined && line.verb !== "begin" && line.stamp === open.stamp) {
            block = undefined;
            return { kind: "reply", ok: line.verb === "end", initial: open.initial, lines: open.lines };
        }
        open.lines.push(text);
        return undefined;
    };

    const parseLine = (raw: string): ControlEvent | undefined => {
        const text = raw.startsWith(DCS_PREFIX) ? raw.slice(DCS_PREFIX.length) : raw;
        if (block !== undefined) {
            return inBlock(block, text);
        }
        if (!text.startsWith("%")) {
            // Nothing outside a block is unprefixed; tmux does not do this, so it is noise to skip, not data.
            return undefined;
        }
        const line = parseBlockLine(text);
        if (line === undefined) {
            return parseNotification(text);
        }
        if (line.verb === "begin") {
            block = { stamp: line.stamp, initial: line.initial, lines: [] };
        }
        // A stray %end/%error with no open block: nothing to close.
        return undefined;
    };

    return {
        feed: (chunk) => {
            const events: ControlEvent[] = [];
            let data = rest.length === 0 ? chunk : Buffer.concat([rest, chunk]);
            let at = data.indexOf(NEWLINE);
            while (at !== -1) {
                const event = parseLine(data.toString("latin1", 0, at));
                if (event !== undefined) {
                    events.push(event);
                }
                data = data.subarray(at + 1);
                at = data.indexOf(NEWLINE);
            }
            // Copy rather than keep a view: the caller may reuse the chunk's memory.
            rest = Buffer.from(data);
            return events;
        },
    };
};

// ------------------------------------------------------------------------------------------------------------
// The client: one `tmux -C …` child, its replies matched to the commands that asked.

export interface ControlClient {
    /* Send commands. Several at once go out in ONE write, so tmux parses and runs them back to back with no
     * pane read between them, which is what makes a "state, then screen" pair read as one moment. One promise
     * per command, in order; a `%error` rejects with its text. Commands must be single lines: a newline would
     * be a second command. */
    readonly send: (commands: readonly string[]) => Promise<readonly string[]>[];
    readonly close: () => void;
}

export interface ControlClientHandlers {
    readonly onOutput: (pane: string, bytes: Buffer) => void;
    readonly onNotice: (name: string, args: string) => void;
    // Once. `reason` is tmux's own words where it had any: the attach's error ("can't find session: x"), or
    // the `%exit` argument.
    readonly onExit: (code: number, reason: string) => void;
}

type ControlChild = ChildProcessByStdio<Writable, Readable, Readable>;

interface Pending {
    readonly resolve: (lines: readonly string[]) => void;
    readonly reject: (error: Error) => void;
}

export const spawnControlClient = (argv: readonly string[], handlers: ControlClientHandlers): ControlClient => {
    // A `$TMUX` in this process's environment (the daemon started from inside a pane, or a test run by an
    // agent whose shell is one) makes tmux refuse to attach as "nested"; a control client is not a nesting.
    const { TMUX: _ignored, ...env } = process.env;
    const child: ControlChild = spawn("tmux", ["-C", ...argv], { stdio: ["pipe", "pipe", "pipe"], env });
    const parser = createControlParser();
    const pending: Pending[] = [];
    let attachError: string | undefined;
    let exited = false;
    let stderr = "";

    const exit = (code: number, reason: string): void => {
        if (exited) {
            return;
        }
        exited = true;
        const error = new Error(`tmux control client ended${reason === "" ? "" : `: ${reason}`}`);
        for (const entry of pending.splice(0)) {
            entry.reject(error);
        }
        handlers.onExit(code, reason);
    };

    const reply = (event: Extract<ControlEvent, { kind: "reply" }>): void => {
        if (event.initial) {
            // The attach's own answer. Its failure is the one that matters: tmux follows it with a bare `%exit`,
            // so the words are kept for that.
            if (!event.ok) {
                attachError = event.lines.join(" ").trim();
            }
            return;
        }
        const entry = pending.shift();
        if (entry === undefined) {
            return;
        }
        if (event.ok) {
            entry.resolve(event.lines);
        } else {
            entry.reject(new Error(event.lines.join(" ").trim() || "tmux command failed"));
        }
    };

    child.stdout.on("data", (chunk: Buffer) => {
        for (const event of parser.feed(chunk)) {
            if (event.kind === "output") {
                handlers.onOutput(event.pane, event.bytes);
            } else if (event.kind === "reply") {
                reply(event);
            } else if (event.kind === "notice") {
                handlers.onNotice(event.name, event.args);
            } else {
                exit(0, attachError ?? event.reason);
            }
        }
    });
    child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => exit(1, error.message));
    child.on("close", (code) => exit(code ?? 1, attachError ?? stderr.trim()));

    return {
        send: (commands) => {
            const promises = commands.map(
                () =>
                    new Promise<readonly string[]>((resolve, reject) => {
                        pending.push({ resolve, reject });
                    }),
            );
            if (exited) {
                const error = new Error("tmux control client ended");
                for (const entry of pending.splice(pending.length - commands.length)) {
                    entry.reject(error);
                }
                return promises;
            }
            child.stdin.write(`${commands.join("\n")}\n`);
            return promises;
        },
        close: () => {
            if (!exited) {
                child.kill();
            }
        },
    };
};

// ------------------------------------------------------------------------------------------------------------
// Re-stating a pane into an empty xterm: what tmux knows about its screen, and the bytes that say the same.

/* The pane's screen state as tmux formats, one line, space-separated in THIS order (parsePaneState reads it
 * back positionally). Every one of these exists on tmux 3.3a; bracketed paste has no format, see below. */
export const PANE_STATE_FORMAT = [
    "#{cursor_x}",
    "#{cursor_y}",
    "#{alternate_on}",
    "#{alternate_saved_x}",
    "#{alternate_saved_y}",
    "#{cursor_flag}",
    "#{insert_flag}",
    "#{keypad_cursor_flag}",
    "#{keypad_flag}",
    "#{mouse_standard_flag}",
    "#{mouse_button_flag}",
    "#{mouse_all_flag}",
    "#{mouse_sgr_flag}",
    "#{mouse_utf8_flag}",
    "#{wrap_flag}",
    "#{origin_flag}",
    "#{scroll_region_upper}",
    "#{scroll_region_lower}",
    "#{pane_height}",
    "#{pane_width}",
    "#{pane_current_command}",
].join(" ");

export interface PaneState {
    readonly cursorX: number;
    readonly cursorY: number;
    readonly alternate: boolean;
    // The normal screen's cursor while the alternate is up (tmux reports UINT_MAX when there is none saved).
    readonly savedX: number | undefined;
    readonly savedY: number | undefined;
    readonly cursorVisible: boolean;
    readonly insert: boolean;
    readonly cursorKeysApplication: boolean;
    readonly keypadApplication: boolean;
    readonly mouseStandard: boolean;
    readonly mouseButton: boolean;
    readonly mouseAll: boolean;
    readonly mouseSgr: boolean;
    readonly mouseUtf8: boolean;
    readonly wrap: boolean;
    readonly origin: boolean;
    readonly scrollTop: number;
    readonly scrollBottom: number;
    readonly height: number;
    readonly width: number;
    readonly command: string;
}

const UNSET = 4_294_967_295;

export const parsePaneState = (line: string): PaneState | undefined => {
    const fields = line.trim().split(" ");
    if (fields.length < 21) {
        return undefined;
    }
    const num = (index: number): number => {
        const value = Number(fields[index]);
        return Number.isFinite(value) ? value : 0;
    };
    const flag = (index: number): boolean => fields[index] === "1";
    const saved = (index: number): number | undefined => (num(index) === UNSET ? undefined : num(index));
    return {
        cursorX: num(0),
        cursorY: num(1),
        alternate: flag(2),
        savedX: saved(3),
        savedY: saved(4),
        cursorVisible: flag(5),
        insert: flag(6),
        cursorKeysApplication: flag(7),
        keypadApplication: flag(8),
        mouseStandard: flag(9),
        mouseButton: flag(10),
        mouseAll: flag(11),
        mouseSgr: flag(12),
        mouseUtf8: flag(13),
        wrap: flag(14),
        origin: flag(15),
        scrollTop: num(16),
        scrollBottom: num(17),
        height: num(18),
        width: num(19),
        // The command may itself contain spaces in theory; everything from field 20 on is it.
        command: fields.slice(20).join(" "),
    };
};

// Shells turn bracketed paste on at every prompt and no format says whether it is on now; assume it for a
// shell at the prompt on the normal screen, which is the state a reattach almost always lands in, and the one
// where a pasted newline running early would be the costly mistake.
const SHELLS = new Set(["zsh", "bash", "fish", "sh", "dash"]);

const ESC = "\x1b";
const cup = (row: number, col: number): string => `${ESC}[${String(row + 1)};${String(col + 1)}H`;

// Each pane mode tmux tracks, and the sequence that turns it on (or, for the two that default ON, off).
const MODE_SEQUENCES: readonly (readonly [(state: PaneState) => boolean, string])[] = [
    [(s) => !s.cursorVisible, `${ESC}[?25l`],
    [(s) => s.insert, `${ESC}[4h`],
    [(s) => s.cursorKeysApplication, `${ESC}[?1h`],
    [(s) => s.keypadApplication, `${ESC}=`],
    [(s) => !s.wrap, `${ESC}[?7l`],
    [(s) => s.mouseStandard, `${ESC}[?1000h`],
    [(s) => s.mouseButton, `${ESC}[?1002h`],
    [(s) => s.mouseAll, `${ESC}[?1003h`],
    [(s) => s.mouseUtf8, `${ESC}[?1005h`],
    [(s) => s.mouseSgr, `${ESC}[?1006h`],
    [(s) => !s.alternate && SHELLS.has(s.command), `${ESC}[?2004h`],
];

// Where the cursor goes, with the scroll region stated first (DECSTBM homes the cursor) and origin mode after
// it, because origin mode changes what a row number means: relative to the region's top.
const cursorSequence = (state: PaneState): string => {
    let out = "";
    const fullRegion = state.scrollTop === 0 && state.scrollBottom >= state.height - 1;
    if (!fullRegion && state.height > 0) {
        out += `${ESC}[${String(state.scrollTop + 1)};${String(state.scrollBottom + 1)}r`;
    }
    if (state.origin) {
        return `${out}${ESC}[?6h${cup(state.cursorY - state.scrollTop, state.cursorX)}`;
    }
    return out + cup(state.cursorY, state.cursorX);
};

/* The bytes that make an empty xterm show what the pane shows. `normal` is `capture-pane -e -J` of the normal
 * screen with as much history as is wanted (or, while the alternate is up, `capture-pane -a` of the saved
 * one); `alternate` is the alternate screen's own capture, only when it is up. Both are line ARRAYS as the
 * block delivered them, latin1 byte-strings.
 *
 * It opens with RIS: whatever xterm held (a previous life's screen, a disconnect banner) is not this pane, and
 * a reset is the only thing that also empties the scrollback the replay is about to refill. Lines are joined
 * with CRLF and never terminated, so the cursor is left ON the last captured row rather than one below it, and
 * the absolute cursor move that follows is exact provided the row count matched, which `-J` arranges: a line
 * tmux wrapped is captured whole and xterm wraps it again at the same width. The scroll region is stated before
 * the final cursor move because DECSTBM homes the cursor; origin mode after it because it changes what a row
 * number means. */
export const synthesizeScreen = (normal: readonly string[], alternate: readonly string[] | undefined, state: PaneState): Buffer => {
    let out = `${ESC}c`;
    out += normal.join("\r\n");
    if (state.alternate) {
        if (state.savedX !== undefined && state.savedY !== undefined) {
            out += cup(state.savedY, state.savedX);
        }
        out += `${ESC}[?1049h`;
        out += (alternate ?? []).join("\r\n");
    }
    out += cursorSequence(state);
    for (const [applies, sequence] of MODE_SEQUENCES) {
        if (applies(state)) {
            out += sequence;
        }
    }
    return Buffer.from(out, "latin1");
};

// ------------------------------------------------------------------------------------------------------------
// The terminal a socket drives: the session's active pane, kept in step.

export interface ControlTerminalSink {
    readonly output: (bytes: Buffer) => void;
    readonly exit: (code: number, reason: string) => void;
}

export interface ControlTerminal {
    // Bytes from the browser (keystrokes, a paste, xterm's mouse reports), into the followed pane as they are.
    readonly input: (bytes: Buffer) => void;
    readonly resize: (cols: number, rows: number) => void;
    // Replay the followed pane from tmux's copy: for a browser that fell behind and has drained (terminal.ts).
    readonly resync: () => void;
    readonly close: () => void;
}

// How much history rides along on an attach. tmux keeps 100k lines a pane; all of them through the tunnel on
// every reload, coloured, would be tens of MB before the prompt appears. This is every line a person scrolls
// back for in practice, and the panel's "Full scrollback" view is there for the rest.
export const ATTACH_HISTORY_LINES = 5000;

// `send-keys -H` takes one hex byte per argument; a paste goes out in slices of this many so no single command
// line grows without bound (tmux parsed 4 KB in one piece on 3.3a; this stays well under).
const INPUT_CHUNK = 1024;

const PANE_ID = /^%\d+$/;
const WINDOW_ID = /^@\d+$/;

const hexOf = (bytes: Buffer): string => {
    const parts: string[] = [];
    for (const byte of bytes) {
        parts.push(byte.toString(16).padStart(2, "0"));
    }
    return parts.join(" ");
};

// Find the active pane in the client's current window, or in a named one.
const activePaneCommand = (window: string | undefined): string =>
    window === undefined ? `display-message -p -F '#{pane_id} #{window_id}'` : `display-message -p -t ${window} -F '#{pane_id} #{window_id}'`;

export const attachControlTerminal = (argv: readonly string[], size: { readonly cols: number; readonly rows: number }, sink: ControlTerminalSink): ControlTerminal => {
    // The pane whose bytes go to the browser; undefined until the first sync has found it.
    let pane: string | undefined;
    let window: string | undefined;
    // Bumped by every sync; a reply for an older one is stale and dropped, and so is pane output that arrives
    // while a sync is in flight (it is already inside the capture that sync is about to deliver, see below).
    let syncing = 0;
    let closed = false;

    const client = spawnControlClient(argv, {
        onOutput: (from, bytes) => {
            if (from === pane && syncing === 0) {
                sink.output(bytes);
            }
        },
        onNotice: (name, args) => {
            // The session's active window moved (a job's new run window, the agent's next command): follow it.
            if (name === "session-window-changed") {
                const next = args.split(" ")[1];
                if (next !== undefined && WINDOW_ID.test(next) && next !== window) {
                    void sync(next);
                }
                return;
            }
            // A different pane became active inside the window we show (a split made from elsewhere).
            if (name === "window-pane-changed") {
                const [inWindow, next] = args.split(" ");
                if (inWindow === window && next !== undefined && PANE_ID.test(next) && next !== pane) {
                    void sync(inWindow);
                }
            }
        },
        onExit: (code, reason) => {
            closed = true;
            sink.exit(code, reason);
        },
    });

    /* Bring the browser to the pane as it is now. Output for the pane is DROPPED for the duration, which is
     * correct rather than lossy: tmux writes a pane's `%output` and a command's reply block onto this client in
     * the order they happened, so any output that arrives before the capture's reply was already on the screen
     * the capture read, and everything after it is new. The state is read first, in the same write as the
     * capture, so the two are one moment as far as tmux's own scheduling allows. */
    // Which pane the browser should be showing: the active pane of the named window, or of the client's own.
    const locate = async (inWindow: string | undefined): Promise<void> => {
        const [located] = await Promise.all(client.send([activePaneCommand(inWindow)]));
        const [foundPane, foundWindow] = (located?.[0] ?? "").trim().split(" ");
        if (foundPane === undefined || !PANE_ID.test(foundPane) || foundWindow === undefined) {
            throw new Error(`no active pane in ${inWindow ?? "the session"}`);
        }
        pane = foundPane;
        window = foundWindow;
    };

    // The pane's screen as bytes for an empty xterm: its state, then the capture(s) that state calls for.
    const capture = async (of: string): Promise<Buffer> => {
        const [stateLines] = await Promise.all(client.send([`display-message -p -t ${of} -F '${PANE_STATE_FORMAT}'`]));
        const state = parsePaneState(stateLines?.[0] ?? "");
        if (state === undefined) {
            throw new Error("unreadable pane state");
        }
        const history = `-S -${String(ATTACH_HISTORY_LINES)}`;
        const captures = state.alternate
            ? [`capture-pane -p -e -J -a ${history} -t ${of}`, `capture-pane -p -e -J -t ${of}`]
            : [`capture-pane -p -e -J ${history} -t ${of}`];
        const [normal, alternate] = await Promise.all(client.send(captures));
        return synthesizeScreen(normal ?? [], alternate, state);
    };

    const sync = async (inWindow: string | undefined): Promise<void> => {
        const generation = ++syncing;
        try {
            await locate(inWindow);
            const screen = await capture(pane ?? "");
            if (generation === syncing && !closed) {
                sink.output(screen);
            }
        } catch {
            // The pane went away mid-sync (a window closing under us), or the client is ending: the next notice
            // or the exit says what happened, and there is nothing to draw for this one.
        } finally {
            if (generation === syncing) {
                syncing = 0;
            }
        }
    };

    // The size first, so the initial replay is captured at the browser's width and re-wraps true; then the
    // session's own active pane, which needs no window named. A client that ends before answering (the attach
    // failed) rejects this, and the exit it ends with is the report.
    client.send([`refresh-client -C ${String(size.cols)},${String(size.rows)}`])[0]?.catch(() => undefined);
    void sync(undefined);

    return {
        input: (bytes) => {
            if (pane === undefined || closed || bytes.length === 0) {
                return;
            }
            const commands: string[] = [];
            for (let at = 0; at < bytes.length; at += INPUT_CHUNK) {
                commands.push(`send-keys -t ${pane} -H ${hexOf(bytes.subarray(at, at + INPUT_CHUNK))}`);
            }
            for (const promise of client.send(commands)) {
                promise.catch(() => undefined);
            }
        },
        resize: (cols, rows) => {
            if (closed) {
                return;
            }
            client.send([`refresh-client -C ${String(cols)},${String(rows)}`])[0]?.catch(() => undefined);
        },
        resync: () => {
            if (!closed) {
                void sync(window);
            }
        },
        close: () => {
            closed = true;
            client.close();
        },
    };
};
