import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { afterEach, beforeAll, expect, test } from "vitest";
import { attachControlTerminal, type ControlTerminal, spawnControlClient } from "./tmux-control.js";

// @xterm/headless v6 ships as CommonJS; Node's ESM lexer can't detect its named exports.
const { Terminal } = createRequire(import.meta.url)("@xterm/headless") as typeof import("@xterm/headless");

// Runs against a real tmux (src/testing/tmux-fence.ts): this module reads one program's behavior, not argv shapes, so
// tests must prove the bytes a browser gets.

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

// afterEach below leaves the server with no sessions, and tmux's `exit-empty` takes a server down the moment it is
// empty — so the next test's `new-session` meets a server already on its way out and gets "server exited unexpectedly"
// instead of a session. The window is one event-loop turn wide, which is nothing on an idle box and plenty on a loaded
// CI one. Pinning holds the (fenced, private) server up for the whole file: fork it with a holder session, turn
// `exit-empty` off, drop the holder. The daemon makes the same move at boot for its own reason — src/terminal/tmux-server.ts.
const PIN_SESSION = `cm-pin-${String(process.pid)}`;
beforeAll(async () => {
    await execFileAsync("tmux", ["new-session", "-A", "-d", "-s", PIN_SESSION]);
    await execFileAsync("tmux", ["set-option", "-g", "exit-empty", "off"]);
    await execFileAsync("tmux", ["kill-session", "-t", `=${PIN_SESSION}`]).catch(() => undefined);
});

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

// Plain `sh`, not $SHELL, for a deterministic prompt with no rc files. The session is created and only attached once
// its prompt appears; new-session returns before the shell execs, so an earlier attach would race it.
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
    await until(() => h.text().includes("\x1bc"), "the initial replay");
    expect(h.text()).toContain("\x1b[?2004h");

    h.terminal.input(Buffer.from("printf 'h\\303\\251llo \\033[31mred\\033[0m\\n'\r", "utf8"));
    await until(() => h.text().includes("\x1b[31mred\x1b[0m"), "the program's output");
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
    // Enters the alternate screen and asks for SGR mouse reporting by hand, then sits in `cat`.
    h.terminal.input(Buffer.from("printf '\\033[?1049h\\033[?1000h\\033[?1006hALT-SCREEN'; cat\r", "utf8"));
    await until(() => h.text().includes("ALT-SCREEN"), "the alternate screen");

    // Second attach to the same session, models a reload.
    const again = open(["attach-session", "-t", `=${name}`]);
    opened.push(again);
    await until(() => again.text().includes("\x1b[?1049h"), "the second attach's replay");
    const replay = again.text();
    const alt = replay.indexOf("\x1b[?1049h");
    expect(replay.slice(0, alt)).toContain("cat");
    expect(replay.indexOf("ALT-SCREEN", alt)).toBeGreaterThan(alt);
    expect(replay).toContain("\x1b[?1000h");
    expect(replay).toContain("\x1b[?1006h");
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
    // Eight lines through a five-row pane push the first ones into scrollback, oldest first.
    expect(replay.startsWith("\x1bc")).toBe(true);
    expect(replay.indexOf("line-1")).toBeLessThan(replay.indexOf("line-8"));
});

// Feeds the replay to xterm's headless core (the same emulator the browser uses) and compares against tmux; long lines
// on a narrow pane so wrapping is exercised too.
test("a replay puts the same rows and the same cursor on an empty xterm that the pane has", async () => {
    const h = await fresh(40, 8);
    await until(() => h.text().includes("\x1bc"), "the initial replay");
    const name = sessions.at(-1) ?? "";
    // Twelve 58-column lines through a 40-column pane: each wraps onto two rows, most scroll into history.
    h.terminal.input(
        Buffer.from("for i in $(seq 1 12); do printf 'line-%02d-%s\\n' $i xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; done\r", "utf8"),
    );
    await until(() => h.text().includes("line-12-"), "the loop's output");
    // Waits for the prompt to return before either side is read.
    await until(() => false, "the prompt", 300).catch(() => undefined);

    const mark = h.text().length;
    h.terminal.resync();
    await until(() => h.text().slice(mark).includes("line-12-"), "the replay");
    await until(() => false, "the replay to finish", 300).catch(() => undefined);
    const replay = Buffer.from(h.text().slice(mark), "utf8");

    const xterm = new Terminal({ cols: 40, rows: 8, scrollback: 1000, allowProposedApi: true });
    await new Promise<void>((resolve) => xterm.write(replay, resolve));
    const buffer = xterm.buffer.active;
    // Trailing spaces trimmed both sides: a typed `# ` is a real cell to xterm but padding to capture-pane, invisible
    // either way.
    const shown = Array.from({ length: 8 }, (_, row) => (buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "").trimEnd());

    const tmuxScreen = (await tmux("capture-pane", "-p", "-t", `=${name}:`)).split("\n").map((line) => line.trimEnd());
    const [cursorX, cursorY] = (await tmux("display", "-p", "-t", `=${name}:`, "#{cursor_x} #{cursor_y}")).split(" ").map(Number);
    expect(shown).toEqual(tmuxScreen);
    expect([buffer.cursorX, buffer.cursorY]).toEqual([cursorX, cursorY]);
    expect(buffer.length).toBeGreaterThan(8);
    expect(buffer.getLine(0)?.translateToString(true)).toContain("for i in");
});

// tmux broadcasts `%session-window-changed` to every control client on the server, not only ones attached to that
// session, so a naive handler walks every tab onto a stranger's window.
test("another session opening a window leaves this tab where it is", async () => {
    const h = await fresh(80, 6);
    await until(() => h.text().includes("\x1bc"), "the initial replay");
    h.terminal.input(Buffer.from("echo MY-OWN-WINDOW\r", "utf8"));
    await until(() => h.text().includes("MY-OWN-WINDOW"), "this session's output");

    // Second session models unrelated work happening elsewhere in the sandbox.
    const other = `cm-other-${String(process.pid)}`;
    sessions.push(other);
    await tmux("new-session", "-d", "-s", other, "-c", "/tmp", "sh");
    const mark = h.text().length;
    await tmux("new-window", "-t", `=${other}:`, "-n", "run", "sh", "-c", "echo STRANGERS-WINDOW; sleep 30");
    // Long enough that a stray sync would have landed by now.
    await until(() => false, "any stray replay", 1500).catch(() => undefined);

    expect(h.text().slice(mark)).toBe("");
    h.terminal.input(Buffer.from("echo STILL-MINE\r", "utf8"));
    await until(() => h.text().includes("STILL-MINE"), "this session's pane still taking input");
    expect(await tmux("capture-pane", "-p", "-t", `=${other}:run`)).toContain("STRANGERS-WINDOW");
});

test("attaching to a session that does not exist ends at once, with tmux's own words", async () => {
    // A session the server can offer, so the miss is about the NAME: tmux says "no sessions" to an attach on an empty
    // server, which would pass a weaker assertion while proving nothing about the name that was asked for.
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

// One stdout chunk can hold a reply block and the `%output` lines written after it; the cut must land before the chunk
// finishes parsing, or new output looks identical to old.
test("a batch's cut lands before any continuation on its own promises", async () => {
    const h = await fresh();
    await until(() => h.text().includes("\x1bc"), "the initial replay");
    const order: string[] = [];
    const client = spawnControlClient(["attach-session", "-t", `=${sessions.at(-1) ?? ""}`], {
        onOutput: () => undefined,
        onNotice: () => undefined,
        onExit: () => undefined,
    });
    try {
        const [reply] = client.send([`display-message -p marker`], () => order.push("cut"));
        await reply?.then((lines) => order.push(`resolved:${lines.join("")}`));
    } finally {
        client.close();
    }
    expect(order).toEqual(["cut", "resolved:marker"]);
});

test("keystrokes that arrive before the attach has found the pane are queued, not swallowed", async () => {
    // `fresh` returns before tmux has answered the attach, so typing here targets a pane not yet known; a tab takes
    // focus the moment it opens, so this race is real.
    const h = await fresh();
    h.terminal.input(Buffer.from("echo TYPED-EARLY\r", "utf8"));
    await until(() => h.text().includes("TYPED-EARLY"), "the early keystrokes reaching the pane");
    expect(h.text()).toContain("TYPED-EARLY");
});

test("the tab follows the session's active window: a new window replays, its close returns", async () => {
    const h = await fresh(80, 6);
    await until(() => h.text().includes("\x1bc"), "the initial replay");
    const name = sessions.at(-1) ?? "";
    h.terminal.input(Buffer.from("echo FIRST-WINDOW\r", "utf8"));
    await until(() => h.text().includes("FIRST-WINDOW"), "the first window's output");

    // Models a job runner opening its next command as a new window (bin/tmux-run).
    let mark = h.text().length;
    await tmux("new-window", "-t", `=${name}:`, "-n", "run", "sh", "-c", "echo SECOND-WINDOW; sleep 30");
    await until(() => h.text().slice(mark).includes("SECOND-WINDOW"), "the second window's replay");
    expect(h.text().slice(mark)).toContain("\x1bc");

    mark = h.text().length;
    await tmux("kill-window", "-t", `=${name}:run`);
    await until(() => h.text().slice(mark).includes("FIRST-WINDOW"), "the first window back");
});
