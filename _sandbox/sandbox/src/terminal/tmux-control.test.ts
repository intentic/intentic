import { expect, test } from "vitest";
import { createControlParser, decodeOutput, type ControlEvent, PANE_STATE_FORMAT, type PaneState, parsePaneState, synthesizeScreen } from "./tmux-control.js";

/* The wire, from transcripts of tmux 3.3a (the image's version), fed in the shapes a pipe actually delivers:
 * whole lines, half lines, several lines in one chunk. The events are what the client and the attach layer
 * act on, so a misread here is a terminal that shows the wrong bytes or waits forever for a reply. */

const feed = (...chunks: string[]): ControlEvent[] => {
    const parser = createControlParser();
    return chunks.flatMap((chunk) => parser.feed(Buffer.from(chunk, "latin1")));
};

test("%output: octal escapes become bytes, everything else passes as the byte it is", () => {
    // ESC, a backslash, a newline, and UTF-8 for "é" (tmux passes bytes ≥ 0x80 through unescaped).
    const bytes = decodeOutput("\\033[31mred\\134\\015\\012h\xc3\xa9");
    expect(bytes.toString("latin1")).toBe("\x1b[31mred\\\r\nh\xc3\xa9");
    expect(bytes.toString("utf8")).toBe("\x1b[31mred\\\r\nhé");
});

test("a backslash that is not followed by three octal digits stays a backslash", () => {
    expect(decodeOutput("a\\b\\12x\\8").toString("latin1")).toBe("a\\b\\12x\\8");
});

test("the attach's own reply is flagged initial; a command's reply is not, and an %error rejects", () => {
    const events = feed(
        "%begin 1788688249 476510 0\n%end 1788688249 476510 0\n",
        "%begin 1788688250 476530 1\n%5 100x30\n%end 1788688250 476530 1\n",
        "%begin 1788688253 476628 1\nparse error: unknown command: nope\n%error 1788688253 476628 1\n",
    );
    expect(events).toEqual([
        { kind: "reply", ok: true, initial: true, lines: [] },
        { kind: "reply", ok: true, initial: false, lines: ["%5 100x30"] },
        { kind: "reply", ok: false, initial: false, lines: ["parse error: unknown command: nope"] },
    ]);
});

test("a line is a line however the pipe cuts it, and a %output split mid-escape decodes whole", () => {
    const events = feed("%outp", "ut %7 he\\03", "3[1mllo\n%exit\n");
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: "output", pane: "%7" });
    expect((events[0] as { bytes: Buffer }).bytes.toString("latin1")).toBe("he\x1b[1mllo");
    expect(events[1]).toEqual({ kind: "exit", reason: "" });
});

test("inside a block only the matching stamp closes it: a captured line that reads like %end is content", () => {
    const events = feed("%begin 10 20 1\n%end 99 99 1\n%output %1 not-output\n%end 10 20 1\n");
    expect(events).toEqual([{ kind: "reply", ok: true, initial: false, lines: ["%end 99 99 1", "%output %1 not-output"] }]);
});

test("notices carry their name and the rest of the line; the -CC preamble is stripped", () => {
    const events = feed("\x1bP1000p%begin 1 2 0\n%end 1 2 0\n%session-window-changed $66 @1864\n%exit detached\n");
    expect(events).toEqual([
        { kind: "reply", ok: true, initial: true, lines: [] },
        { kind: "notice", name: "session-window-changed", args: "$66 @1864" },
        { kind: "exit", reason: "detached" },
    ]);
});

/* The pane's state, as tmux 3.3a printed it for a fresh zsh in a 100x30 pane, and the bytes that put an empty
 * xterm into the same state. */

const FRESH_SHELL = "4 1 0 4294967295 4294967295 1 0 1 1 0 0 0 0 0 1 0 0 29 30 100 zsh";

test("the state line reads back positionally, in the format's own order", () => {
    expect(PANE_STATE_FORMAT.split(" ")).toHaveLength(21);
    const state = parsePaneState(FRESH_SHELL);
    expect(state).toMatchObject({
        cursorX: 4,
        cursorY: 1,
        alternate: false,
        savedX: undefined,
        savedY: undefined,
        cursorVisible: true,
        cursorKeysApplication: true,
        keypadApplication: true,
        wrap: true,
        scrollTop: 0,
        scrollBottom: 29,
        height: 30,
        width: 100,
        command: "zsh",
    });
    expect(parsePaneState("too short")).toBeUndefined();
});

const state = (patch: Partial<PaneState> = {}): PaneState => ({ ...(parsePaneState(FRESH_SHELL) as PaneState), ...patch });

test("a normal screen: reset, the lines CRLF-joined and unterminated, the cursor, then the modes", () => {
    const bytes = synthesizeScreen(["$ ls", "a  b", "$ "], undefined, state({ cursorX: 2, cursorY: 2 })).toString("latin1");
    // RIS first, so an earlier life's screen and scrollback are gone before the replay refills them.
    expect(bytes.startsWith("\x1bc$ ls\r\na  b\r\n$ ")).toBe(true);
    // No trailing CRLF: the cursor is left on the last captured row, and the move is to (row 3, col 3).
    expect(bytes).toContain("$ \x1b[3;3H");
    // A full-height scroll region is the default and is not stated; zsh's DECCKM/keypad flags are; bracketed
    // paste is assumed for a shell on the normal screen.
    expect(bytes).not.toContain("r");
    expect(bytes.endsWith("\x1b[?1h\x1b=\x1b[?2004h")).toBe(true);
});

test("the alternate screen: the saved normal screen goes under it, then 1049h, then the alternate's own rows", () => {
    const bytes = synthesizeScreen(["$ vim", "$ "], ["~", "~", "-- INSERT --"], state({ alternate: true, savedX: 2, savedY: 1, cursorX: 0, cursorY: 0, mouseAll: true, mouseSgr: true, command: "vim" })).toString(
        "latin1",
    );
    expect(bytes).toBe("\x1bc$ vim\r\n$ \x1b[2;3H\x1b[?1049h~\r\n~\r\n-- INSERT --\x1b[1;1H\x1b[?1h\x1b=\x1b[?1003h\x1b[?1006h");
});

test("a scroll region is stated before the cursor move, and origin mode makes the move region-relative", () => {
    const bytes = synthesizeScreen(["x"], undefined, state({ scrollTop: 2, scrollBottom: 20, cursorY: 5, cursorX: 0, origin: true })).toString("latin1");
    expect(bytes).toContain("\x1b[3;21r\x1b[?6h\x1b[4;1H");
});

test("hidden cursor, insert mode and no-wrap are restated as the sequences that turn them on", () => {
    const bytes = synthesizeScreen([], undefined, state({ cursorVisible: false, insert: true, wrap: false, command: "less" })).toString("latin1");
    expect(bytes).toContain("\x1b[?25l");
    expect(bytes).toContain("\x1b[4h");
    expect(bytes).toContain("\x1b[?7l");
    // `less` is not a shell: no bracketed paste guessed for it.
    expect(bytes).not.toContain("2004h");
});
