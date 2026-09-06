import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { attachControlTerminal, type ControlTerminal } from "./tmux-control.js";

// @xterm/headless v6 ships as CommonJS whose named exports Node's ESM lexer can't detect (logs/pane-log-clean.ts
// loads it the same way).
const { Terminal } = createRequire(import.meta.url)("@xterm/headless") as typeof import("@xterm/headless");

/* Against a REAL tmux (the suite's private server, src/testing/tmux-fence.ts), because the whole module is a
 * reading of one program's behaviour: what its control client says, in what order, and what its formats
 * report. Argv assertions would only restate the source; these prove the bytes a browser would get. */

const execFileAsync = promisify(execFile);
const tmux = async (...args: string[]): Promise<string> => (await execFileAsync("tmux", args)).stdout.trim();

const until = async (check: () => boolean, what: string, ms = 10_000): Promise<void> => {
    const deadline = Date.now() + ms;
    while (!check()) {
        if (Date.now() > deadline) {
            throw new Error(`timed out waiting for ${what}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
};

interface Harness {
    readonly terminal: ControlTerminal;
    readonly text: () => string;
    readonly exits: { code: number; reason: string }[];
}

const open = (argv: string[], cols = 80, rows = 24): Harness => {
    const chunks: Buffer[] = [];
    const exits: { code: number; reason: string }[] = [];
    const terminal = attachControlTerminal(argv, { cols, rows }, {
        output: (bytes) => chunks.push(bytes),
        exit: (code, reason) => exits.push({ code, reason }),
    });
    return { terminal, text: () => Buffer.concat(chunks).toString("utf8"), exits };
};

const opened: Harness[] = [];
const sessions: string[] = [];
afterEach(async () => {
    for (const h of opened.splice(0)) {
        h.terminal.close();
    }
    for (const name of sessions.splice(0)) {
        await execFileAsync("tmux", ["kill-session", "-t", `=${name}`]).catch(() => undefined);
    }
});

// A plain `sh` rather than whatever $SHELL is here: deterministic prompt, no rc files, and it is what a fresh
// session's argv can name (tmux ignores the command when `-A` finds the session already there).
//
// The session is CREATED first and attached to only once its shell has printed a prompt, because those are not
// one moment. `new-session` answers when the pane's process has been FORKED; until it execs the shell, tmux
// reports `#{pane_current_command}` as whatever that fork inherited — its own `tmux`, or the session's
// default shell — and a replay taken there re-states the modes of a program that is not running yet. Attaching
// into that window is racing the exec, not testing the module: CI lost the race and got an opening replay
// carrying the shell's prompt and none of the shell's modes. The prompt IS the exec, so waiting for it is the
// wait; the attach below still uses the production argv, which `-A` resolves to an attach.
const fresh = async (cols = 80, rows = 24): Promise<Harness> => {
    const name = `cm-${process.pid}-${String(sessions.length)}`;
    sessions.push(name);
    await execFileAsync("tmux", ["new-session", "-d", "-s", name, "-x", String(cols), "-y", String(rows), "-c", "/tmp", "sh"]);
    const deadline = Date.now() + 10_000;
    while ((await tmux("capture-pane", "-p", "-t", `=${name}:`)) === "") {
        if (Date.now() > deadline) {
            throw new Error(`timed out waiting for the shell's prompt in ${name}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const h = open(["new-session", "-A", "-s", name, "-c", "/tmp", "sh"], cols, rows);
    opened.push(h);
    return h;
};

test("an attach opens with a reset-and-replay, then the pane's raw bytes follow, colour and UTF-8 intact", async () => {
    const h = await fresh();
    // The opening screen: RIS, then the (near-empty) pane, then the cursor and the shell's modes.
    await until(() => h.text().includes("\x1bc"), "the initial replay");
    expect(h.text()).toContain("\x1b[?2004h");

    h.terminal.input(Buffer.from("printf 'h\\303\\251llo \\033[31mred\\033[0m\\n'\r", "utf8"));
    await until(() => h.text().includes("\x1b[31mred\x1b[0m"), "the program's output");
    // Raw: the SGR the program wrote, not a redraw of tmux's idea of it; the UTF-8 decoded whole.
    expect(h.text()).toContain("héllo \x1b[31mred\x1b[0m");
});

test("a resize reaches the pane, and the replay is captured at the browser's width", async () => {
    const h = await fresh(80, 24);
    await until(() => h.text().includes("\x1bc"), "the initial replay");
    const name = sessions.at(-1) ?? "";
    expect(await tmux("display", "-p", "-t", `=${name}:`, "#{pane_width}x#{pane_height}")).toBe("80x24");

    h.terminal.resize(120, 40);
    await until(() => false, "the pane to resize", 800).catch(() => undefined);
    expect(await tmux("display", "-p", "-t", `=${name}:`, "#{pane_width}x#{pane_height}")).toBe("120x40");
});

test("a program on the alternate screen is replayed there on a fresh attach, with the mouse it asked for", async () => {
    const h = await fresh();
    await until(() => h.text().includes("\x1bc"), "the initial replay");
    const name = sessions.at(-1) ?? "";
    // Enter the alternate screen and ask for SGR mouse reporting by hand, as vim would, then sit in `cat`.
    h.terminal.input(Buffer.from("printf '\\033[?1049h\\033[?1000h\\033[?1006hALT-SCREEN'; cat\r", "utf8"));
    await until(() => h.text().includes("ALT-SCREEN"), "the alternate screen");

    // A second attach to the same session, as a reload would: the replay must land on the alternate screen.
    const again = open(["attach-session", "-t", `=${name}`]);
    opened.push(again);
    await until(() => again.text().includes("\x1b[?1049h"), "the second attach's replay");
    const replay = again.text();
    const alt = replay.indexOf("\x1b[?1049h");
    // The normal screen first (the shell's echo of the command line, which spells ALT-SCREEN out literally),
    // then the switch, then the alternate screen's own rows.
    expect(replay.slice(0, alt)).toContain("cat");
    expect(replay.indexOf("ALT-SCREEN", alt)).toBeGreaterThan(alt);
    expect(replay).toContain("\x1b[?1000h");
    expect(replay).toContain("\x1b[?1006h");
    // And not the shell's bracketed paste: what is running is `cat`, not a prompt.
    expect(replay).not.toContain("\x1b[?2004h");
});

test("a second replay puts history under the screen, and the resync does the same on demand", async () => {
    const h = await fresh(80, 5);
    await until(() => h.text().includes("\x1bc"), "the initial replay");
    h.terminal.input(Buffer.from("for i in 1 2 3 4 5 6 7 8; do echo line-$i; done\r", "utf8"));
    await until(() => h.text().includes("line-8"), "the loop's output");

    const before = h.text().length;
    h.terminal.resync();
    await until(() => h.text().length > before && h.text().slice(before).includes("line-8"), "the resync's replay");
    const replay = h.text().slice(before);
    // Eight lines through a five-row pane: the first ones scrolled off the screen into history, and the replay
    // carries them back, oldest first, so xterm's scrollback holds them.
    expect(replay.startsWith("\x1bc")).toBe(true);
    expect(replay.indexOf("line-1")).toBeLessThan(replay.indexOf("line-8"));
});

/* THE REPLAY IS THE SCREEN. Everything above checks that the right bytes are in the stream; this feeds a replay
 * to a terminal (xterm's headless core, the same emulator the browser runs) and compares what it shows with
 * what tmux shows: the visible rows, and the cursor, which is only right if `-J`'s rejoined lines re-wrapped
 * into exactly the rows tmux had them on. Long lines on a narrow pane, so that wrapping is what is tested. */
test("a replay puts the same rows and the same cursor on an empty xterm that the pane has", async () => {
    const h = await fresh(40, 8);
    await until(() => h.text().includes("\x1bc"), "the initial replay");
    const name = sessions.at(-1) ?? "";
    // Twelve 58-column lines through a 40-column pane: each wraps onto two rows, most scroll into history.
    h.terminal.input(
        Buffer.from("for i in $(seq 1 12); do printf 'line-%02d-%s\\n' $i xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; done\r", "utf8"),
    );
    await until(() => h.text().includes("line-12-"), "the loop's output");
    // Let the prompt come back before reading either side.
    await until(() => false, "the prompt", 300).catch(() => undefined);

    const mark = h.text().length;
    h.terminal.resync();
    await until(() => h.text().slice(mark).includes("line-12-"), "the replay");
    await until(() => false, "the replay to finish", 300).catch(() => undefined);
    const replay = Buffer.from(h.text().slice(mark), "utf8");

    const xterm = new Terminal({ cols: 40, rows: 8, scrollback: 1000, allowProposedApi: true });
    await new Promise<void>((resolve) => xterm.write(replay, resolve));
    const buffer = xterm.buffer.active;
    // Trailing spaces trimmed on both sides: a prompt's typed `# ` is a real cell to xterm and padding to
    // capture-pane's reader, and neither is visible.
    const shown = Array.from({ length: 8 }, (_, row) => (buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "").trimEnd());

    const tmuxScreen = (await tmux("capture-pane", "-p", "-t", `=${name}:`)).split("\n").map((line) => line.trimEnd());
    const [cursorX, cursorY] = (await tmux("display", "-p", "-t", `=${name}:`, "#{cursor_x} #{cursor_y}")).split(" ").map(Number);
    expect(shown).toEqual(tmuxScreen);
    expect([buffer.cursorX, buffer.cursorY]).toEqual([cursorX, cursorY]);
    // And the scrollback holds what scrolled off: the first line is there, above the screen.
    expect(buffer.length).toBeGreaterThan(8);
    expect(buffer.getLine(0)?.translateToString(true)).toContain("for i in");
});

/* AND ONLY ITS OWN SESSION'S. tmux broadcasts `%session-window-changed` to EVERY control client on the server,
 * not just the ones attached to the session it is about, so a sandbox where anything else is working — every
 * agent command opens a window in its `agent-*` session, every job command one in a `job-*` session — used to
 * walk every open tab onto that window: a reset, then a replay of a stranger's pane, most often one that had
 * just started and had nothing on it yet. That is what a Checks tab going blank mid-run was. */
test("another session opening a window leaves this tab where it is", async () => {
    const h = await fresh(80, 6);
    await until(() => h.text().includes("\x1bc"), "the initial replay");
    h.terminal.input(Buffer.from("echo MY-OWN-WINDOW\r", "utf8"));
    await until(() => h.text().includes("MY-OWN-WINDOW"), "this session's output");

    // A second session (any other work in the sandbox) makes its own new window the active one.
    const other = `cm-other-${String(process.pid)}`;
    sessions.push(other);
    await tmux("new-session", "-d", "-s", other, "-c", "/tmp", "sh");
    const mark = h.text().length;
    await tmux("new-window", "-t", `=${other}:`, "-n", "run", "sh", "-c", "echo STRANGERS-WINDOW; sleep 30");
    // Long enough that a sync would have landed (the replays above arrive in well under this).
    await until(() => false, "any stray replay", 1500).catch(() => undefined);

    // Nothing was sent, so nothing reset the browser's xterm and no stranger's pane reached it.
    expect(h.text().slice(mark)).toBe("");
    // And this tab is still typing into its own pane.
    h.terminal.input(Buffer.from("echo STILL-MINE\r", "utf8"));
    await until(() => h.text().includes("STILL-MINE"), "this session's pane still taking input");
    expect(await tmux("capture-pane", "-p", "-t", `=${other}:run`)).toContain("STRANGERS-WINDOW");
});

test("attaching to a session that does not exist ends at once, with tmux's own words", async () => {
    // A server with SOME session on it, so the answer is about this name and not "no sessions" from a server
    // that is not running at all (the default `exit-empty` takes the fenced server down with its last session).
    const other = await fresh();
    await until(() => other.text().includes("\x1bc"), "the other session's replay");

    const h = open(["attach-session", "-t", "=cm-no-such-session"]);
    opened.push(h);
    await until(() => h.exits.length > 0, "the exit");
    expect(h.exits[0]?.reason).toContain("can't find session");
    expect(h.text()).toBe("");
});

test("the session being killed from elsewhere is an exit, not a hang", async () => {
    const h = await fresh();
    await until(() => h.text().includes("\x1bc"), "the initial replay");
    await tmux("kill-session", "-t", `=${sessions.at(-1) ?? ""}`);
    await until(() => h.exits.length > 0, "the exit");
    expect(h.exits[0]?.code).toBe(0);
});

test("the tab follows the session's active window: a new window replays, its close returns", async () => {
    const h = await fresh(80, 6);
    await until(() => h.text().includes("\x1bc"), "the initial replay");
    const name = sessions.at(-1) ?? "";
    h.terminal.input(Buffer.from("echo FIRST-WINDOW\r", "utf8"));
    await until(() => h.text().includes("FIRST-WINDOW"), "the first window's output");

    // A job's runner opens its next command as a new window (bin/tmux-run): the browser should now show that.
    let mark = h.text().length;
    await tmux("new-window", "-t", `=${name}:`, "-n", "run", "sh", "-c", "echo SECOND-WINDOW; sleep 30");
    await until(() => h.text().slice(mark).includes("SECOND-WINDOW"), "the second window's replay");
    expect(h.text().slice(mark)).toContain("\x1bc");

    // Its command ending closes the window, and the session's active window is the shell again.
    mark = h.text().length;
    await tmux("kill-window", "-t", `=${name}:run`);
    await until(() => h.text().slice(mark).includes("FIRST-WINDOW"), "the first window back");
});
