import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

// Browser tmux client uses `tmux -C`: a line protocol, not a screen, so xterm owns scrollback/selection/search while
// tmux keeps the shell alive between attaches. Keystrokes go straight into the pane, never to tmux, so bindings are
// unreachable. attachControlTerminal follows its own session's pane, since notices broadcast to every client.

// The wire.

export type ControlEvent =
    // Already unescaped; UTF-8 not decoded here, a chunk boundary can split a character before xterm decodes it.
    | { readonly kind: "output"; readonly pane: string; readonly bytes: Buffer }
    // One command's reply; `initial` flags the attach's own unrequested block (0), later commands are 1.
    | { readonly kind: "reply"; readonly ok: boolean; readonly initial: boolean; readonly lines: readonly string[] }
    // Any other `%…` line (session or window state changes).
    | { readonly kind: "notice"; readonly name: string; readonly args: string }
    // Client is ending: the session was destroyed, or an empty line detached it.
    | { readonly kind: "exit"; readonly reason: string };

export interface ControlParser {
    // Feed the child's stdout as it arrives; partial lines are held across calls.
    readonly feed: (chunk: Buffer) => ControlEvent[];
}

// `-CC` prefixes the first line with this DCS; `-C` does not, but it is stripped either way.
const DCS_PREFIX = "\x1bP1000p";

const NEWLINE = 0x0a;

// Below-0x20 bytes and the backslash itself become `\ooo` octal; everything else, including UTF-8's upper range, passes
// through. Handled as latin1 so one char is one byte.
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

// Captures the stamp the matching %end/%error must repeat, and the initial-block flag.
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
        // Empty payload after `%output %5 ` is a real line (pane wrote nothing decodable), not a missing one.
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

    // Only the block's own stamp closes it, so a captured line that itself reads `%end …` can't end it early.
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
            // Nothing outside a block is unprefixed in tmux's own output; skip as noise, not data.
            return undefined;
        }
        const line = parseBlockLine(text);
        if (line === undefined) {
            return parseNotification(text);
        }
        if (line.verb === "begin") {
            block = { stamp: line.stamp, initial: line.initial, lines: [] };
        }
        // Stray %end/%error with no open block: nothing to close.
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
            // Copies rather than keeps a view, since the caller may reuse the chunk's memory.
            rest = Buffer.from(data);
            return events;
        },
    };
};

// The client: one tmux -C child, replies matched to the commands that asked.

export interface ControlClient {
    // Batched commands go out in one write so tmux runs them back to back; one promise per command in order, `%error`
    // rejects. `onSettled` fires synchronously as the last reply is parsed, before any `.then` runs.
    readonly send: (commands: readonly string[], onSettled?: () => void) => Promise<readonly string[]>[];
    readonly close: () => void;
}

export interface ControlClientHandlers {
    readonly onOutput: (pane: string, bytes: Buffer) => void;
    readonly onNotice: (name: string, args: string) => void;
    // Fires once; `reason` is tmux's own words when it had any (the attach's error, or the `%exit` argument).
    readonly onExit: (code: number, reason: string) => void;
}

type ControlChild = ChildProcessByStdio<Writable, Readable, Readable>;

interface Pending {
    readonly resolve: (lines: readonly string[]) => void;
    readonly reject: (error: Error) => void;
    // Set on a batch's last command: the caller's synchronous cut point (see ControlClient.send).
    readonly settled?: (() => void) | undefined;
}

export const spawnControlClient = (argv: readonly string[], handlers: ControlClientHandlers): ControlClient => {
    // $TMUX in this process's env makes tmux refuse to attach as nested; a control client is not nesting.
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
            // The attach's own answer; a failure here is followed by a bare `%exit`, so its words are kept for that.
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
        // Still synchronous after settling: the cut lands exactly between this reply and the rest of the chunk.
        entry.settled?.();
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
        send: (commands, onSettled) => {
            const last = commands.length - 1;
            const promises = commands.map(
                (_command, index) =>
                    new Promise<readonly string[]>((resolve, reject) => {
                        pending.push({ resolve, reject, settled: index === last ? onSettled : undefined });
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

// Re-stating a pane into an empty xterm.

// Space-separated, in this exact order; parsePaneState reads it back positionally.
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
    // Normal screen's cursor while the alternate is up; tmux reports UINT_MAX (UNSET) when nothing is saved.
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
        // Command may itself contain spaces; everything from field 20 on is it.
        command: fields.slice(20).join(" "),
    };
};

// No format reports live bracketed-paste state; assumed for a shell at the prompt on the normal screen.
const SHELLS = new Set(["zsh", "bash", "fish", "sh", "dash"]);

const ESC = "\x1b";
const cup = (row: number, col: number): string => `${ESC}[${String(row + 1)};${String(col + 1)}H`;

// Each pane mode tmux tracks, and the sequence that turns it on (or off, for the two that default on).
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

// Scroll region is stated first (DECSTBM homes the cursor), origin mode after: it changes what a row number means,
// relative to the region's top.
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

// Opens with RIS to clear whatever xterm held; CRLF-joined and unterminated lines leave the cursor on the last captured
// row, matching `-J`'s rejoined wrapping. Scroll region precedes the cursor move, origin mode after.
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

// The terminal a socket drives: the session's active pane, kept in step.

export interface ControlTerminalSink {
    readonly output: (bytes: Buffer) => void;
    readonly exit: (code: number, reason: string) => void;
}

export interface ControlTerminal {
    // Bytes from the browser (keystrokes, paste, mouse reports) into the followed pane as-is.
    readonly input: (bytes: Buffer) => void;
    readonly resize: (cols: number, rows: number) => void;
    // Replays the followed pane from tmux's copy, for a browser that fell behind and drained (terminal.ts).
    readonly resync: () => void;
    readonly close: () => void;
}

// tmux keeps 100k lines per pane; sending it all on every reload would be tens of MB.
export const ATTACH_HISTORY_LINES = 5000;

// One hex byte per `send-keys -H` argument; a paste is sliced this wide so no command line grows unbounded.
const INPUT_CHUNK = 1024;

const PANE_ID = /^%\d+$/;
const WINDOW_ID = /^@\d+$/;
const SESSION_ID = /^\$\d+$/;

// Ceiling on pane output held during a sync, and on keystrokes queued before the first pane is found; past the cap the
// excess is dropped.
const HELD_MAX_BYTES = 4_194_304;
const QUEUED_INPUT_MAX = 256;

const hexOf = (bytes: Buffer): string => {
    const parts: string[] = [];
    for (const byte of bytes) {
        parts.push(byte.toString(16).padStart(2, "0"));
    }
    return parts.join(" ");
};

// Finds the active pane in the current window or a named one, and whose session it is in: tmux notices are broadcast,
// so a window id here isn't necessarily ours; `-t @<id>` resolves its real session.
const activePaneCommand = (window: string | undefined): string =>
    window === undefined
        ? `display-message -p -F '#{session_id} #{pane_id} #{window_id}'`
        : `display-message -p -t ${window} -F '#{session_id} #{pane_id} #{window_id}'`;

export interface PaneLocation {
    readonly session: string;
    readonly pane: string;
    readonly window: string;
}

// That command's answer, `$3 %7 @2`. Undefined when tmux had nothing to say (a closed window errors, an empty reply
// reads the same).
export const parseLocation = (line: string): PaneLocation | undefined => {
    const [session = "", pane = "", window = ""] = line.trim().split(" ");
    if (!SESSION_ID.test(session) || !PANE_ID.test(pane) || !WINDOW_ID.test(window)) {
        return undefined;
    }
    return { session, pane, window };
};

export const attachControlTerminal = (argv: readonly string[], size: { readonly cols: number; readonly rows: number }, sink: ControlTerminalSink): ControlTerminal => {
    // Pane whose bytes go to the browser; undefined until the first sync finds it.
    let pane: string | undefined;
    let window: string | undefined;
    // Learned once from the opening sync; a tab stays on that session, since tmux notices are broadcast.
    let session: string | undefined;
    // Bumped every sync, never reset, so a stale sync finishing late can't be mistaken for the newest one.
    let generation = 0;
    // Output held while a sync is in flight; held, not dropped, since it may be new and exist nowhere else.
    let held: Buffer[] | undefined;
    let heldBytes = 0;
    // Keystrokes typed before the first sync found a pane; flushed by `locate`.
    let queuedInput: Buffer[] | undefined = [];
    let closed = false;

    // `%session-window-changed $<session> @<window>`: a session's active window moved. Follows only when the session
    // matches ours; tmux broadcasts this to every client.
    const followWindow = (args: string): void => {
        const [inSession, next] = args.split(" ");
        if (inSession === session && next !== undefined && WINDOW_ID.test(next) && next !== window) {
            void sync(next);
        }
    };

    // `%window-pane-changed @<window> %<pane>`: a different pane became active in a window (a split elsewhere). A
    // window id is unique server-wide, so a match to our window is proof enough.
    const followPane = (args: string): void => {
        const [inWindow, next] = args.split(" ");
        if (inWindow === window && next !== undefined && PANE_ID.test(next) && next !== pane) {
            void sync(inWindow);
        }
    };

    const client = spawnControlClient(argv, {
        onOutput: (from, bytes) => {
            if (from !== pane) {
                return;
            }
            if (held !== undefined) {
                heldBytes += bytes.length;
                if (heldBytes <= HELD_MAX_BYTES) {
                    held.push(bytes);
                }
                return;
            }
            sink.output(bytes);
        },
        // Every `%…` notice is broadcast to every control client regardless of session; the session id it carries is
        // the only way to tell whether it is this tab's.
        onNotice: (name, args) => {
            if (name === "session-window-changed") {
                followWindow(args);
            } else if (name === "window-pane-changed") {
                followPane(args);
            }
        },
        onExit: (code, reason) => {
            closed = true;
            sink.exit(code, reason);
        },
    });

    // Keystrokes into the followed pane, sliced so no single command line grows unbounded.
    const sendInput = (into: string, bytes: Buffer): void => {
        const commands: string[] = [];
        for (let at = 0; at < bytes.length; at += INPUT_CHUNK) {
            commands.push(`send-keys -t ${into} -H ${hexOf(bytes.subarray(at, at + INPUT_CHUNK))}`);
        }
        for (const promise of client.send(commands)) {
            promise.catch(() => undefined);
        }
    };

    // Active pane of the named window, or the client's own when none is named. Finding it the first time also releases
    // anything typed before there was a pane to type into.
    const locate = async (inWindow: string | undefined): Promise<void> => {
        const [located] = await Promise.all(client.send([activePaneCommand(inWindow)]));
        const found = parseLocation(located?.[0] ?? "");
        if (found === undefined) {
            throw new Error(`no active pane in ${inWindow ?? "the session"}`);
        }
        if (inWindow === undefined) {
            // Opening sync asks with no target, so whichever session tmux answers about is the one this client stays
            // on.
            session = found.session;
        } else if (found.session !== session) {
            // Window belongs to another session; the notice filter already turns these away, this backs it up.
            throw new Error(`window ${inWindow} is not in ${session ?? "this session"}`);
        }
        pane = found.pane;
        window = found.window;
        // Pane is known now: anything typed earlier is released here, in the order it was typed.
        const queued = queuedInput ?? [];
        queuedInput = undefined;
        for (const bytes of queued) {
            sendInput(found.pane, bytes);
        }
    };

    // State and all three captures go out in one write, since which capture is wanted is known only once the state
    // returns. `-a` errors unless the alternate screen is up; the alternate capture takes no `-S`, it has no history.
    const capture = async (of: string, mine: number): Promise<Buffer> => {
        const history = `-S -${String(ATTACH_HISTORY_LINES)}`;
        // Every reply is optional: a client ending mid-sync rejects all four, or one await unhandled-rejects the rest.
        const [stateLines, saved, normal, screen] = await Promise.all(
            client
                .send(
                    [
                        `display-message -p -t ${of} -F '${PANE_STATE_FORMAT}'`,
                        `capture-pane -p -e -J -a ${history} -t ${of}`,
                        `capture-pane -p -e -J ${history} -t ${of}`,
                        `capture-pane -p -e -J -t ${of}`,
                    ],
                    // The cut: output before this reply is already in the capture and discarded; after it is new and
                    // kept.
                    () => {
                        if (mine === generation) {
                            held = [];
                            heldBytes = 0;
                        }
                    },
                )
                .map((reply) => reply.catch(() => undefined)),
        );
        const state = parsePaneState(stateLines?.[0] ?? "");
        if (state === undefined) {
            throw new Error("unreadable pane state");
        }
        if (state.alternate) {
            return synthesizeScreen(saved ?? [], screen ?? [], state);
        }
        return synthesizeScreen(normal ?? [], undefined, state);
    };

    // Finds the pane, reads its state and screen together, draws them as one picture, then puts whatever it wrote
    // meanwhile on top. State and capture share one write so both are the same moment tmux allows.
    const sync = async (inWindow: string | undefined): Promise<void> => {
        const mine = ++generation;
        held = [];
        heldBytes = 0;
        let screen: Buffer | undefined;
        try {
            await locate(inWindow);
            screen = await capture(pane ?? "", mine);
        } catch {
            // Pane gone mid-sync, or client ending: the next notice or exit explains it; held output still flushes.
        }
        if (mine !== generation) {
            // A newer sync started meanwhile; it owns `held` and covers this window, so this screen would be stale.
            return;
        }
        const rest = held ?? [];
        held = undefined;
        heldBytes = 0;
        if (closed) {
            return;
        }
        if (screen !== undefined) {
            sink.output(screen);
        }
        for (const chunk of rest) {
            sink.output(chunk);
        }
    };

    // Size first, so the initial replay is captured at the browser's width; then the session's active pane.
    client.send([`refresh-client -C ${String(size.cols)},${String(size.rows)}`])[0]?.catch(() => undefined);
    void sync(undefined);

    return {
        input: (bytes) => {
            if (closed || bytes.length === 0) {
                return;
            }
            if (pane === undefined) {
                // Typed before the first sync found a pane; queued, since eating the first keystroke reads as broken.
                if (queuedInput !== undefined && queuedInput.length < QUEUED_INPUT_MAX) {
                    queuedInput.push(bytes);
                }
                return;
            }
            sendInput(pane, bytes);
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
