import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { armShellJail, disarmShellJail, jailedDefaultCommand, shellJailFiles, type Tmux } from "./shell-jail.js";

// The shell jail's arming against a stand-in tmux and a real directory, and its line run by a real bash with stand-ins
// for tmux and bwrap on PATH: what the pane would exec, for a person's session and for one of the daemon's.

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const scratch = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "shell-jail-"));
    roots.push(root);
    return root;
};

// A server holding one default-command and the panes `listing` names; every call is recorded.
const fakeTmux = (state: { command: string; listing: string }) => {
    const calls: string[][] = [];
    const tmux: Tmux = async (args) => {
        calls.push([...args]);
        if (args[0] === "show-options") {
            return `${state.command}\n`;
        }
        if (args[0] === "set-option" && args[2] === "default-command") {
            state.command = args[3] ?? "";
        }
        return args[0] === "list-panes" ? state.listing : "";
    };
    return { tmux, calls };
};

test("arming writes the arguments where only root reads them, swaps the line in, and ends people's shells opened before", async () => {
    const files = shellJailFiles(join(await scratch(), "jail"));
    const state = { command: "zsh", listing: "web-old\t1\t\npanel-site\t1\t\n" };
    const { tmux, calls } = fakeTmux(state);
    await armShellJail(["--unshare-pid", "--ro-bind", "/usr", "/usr"], files, tmux);
    expect(await readFile(files.args, "utf8")).toBe("--unshare-pid\0--ro-bind\0/usr\0/usr\0");
    expect(state.command).toBe(jailedDefaultCommand("zsh", files));
    expect(await readFile(files.original, "utf8")).toBe("zsh");
    expect(calls.filter((call) => call[0] === "kill-session").map((call) => call[2])).toEqual(["=intentic-server-pin", "=web-old"]);
    // Armed again, the line is not read back as the server's own.
    await armShellJail(["--unshare-pid"], files, tmux);
    expect(await readFile(files.original, "utf8")).toBe("zsh");
    await disarmShellJail(files, tmux);
    expect(state.command).toBe("zsh");
});

test("disarming where the jail was never armed asks tmux nothing", async () => {
    const files = shellJailFiles(join(await scratch(), "jail"));
    const state = { command: "zsh", listing: "" };
    const { tmux, calls } = fakeTmux(state);
    await disarmShellJail(files, tmux);
    expect(calls).toEqual([]);
    expect(state.command).toBe("zsh");
});

// Stand-ins on PATH: `tmux display-message` answers the session's name, `bwrap` and `zsh` print what they were given.
const runLine = async (session: string): Promise<{ readonly out: string; readonly dir: string }> => {
    const root = await scratch();
    const bin = join(root, "bin");
    await mkdir(bin);
    const files = shellJailFiles(join(root, "jail"));
    await mkdir(files.dir);
    await writeFile(files.args, "--ro-bind\0/usr\0/usr\0");
    const stub = async (name: string, body: string): Promise<void> => {
        await writeFile(join(bin, name), `#!/bin/bash\n${body}\n`);
        await chmod(join(bin, name), 0o755);
    };
    await stub("tmux", `[ "$1" = display-message ] && echo ${session}; exit 0`);
    await stub("zsh", `echo "zsh $*"`);
    await stub("bwrap", `printf 'bwrap'; printf ' %s' "$@"; printf ' fd3:'; tr '\\0' ' ' <&3; echo`);
    // The line names bwrap absolutely, as the image has it; the stand-in takes its place for this run.
    const line = jailedDefaultCommand("zsh", files).replace("/usr/bin/bwrap", "bwrap");
    const { stdout } = await execFileAsync("bash", ["-c", line], { cwd: root, env: { PATH: `${bin}:/usr/bin:/bin`, TMUX_PANE: "%1" } });
    return { out: stdout.trim(), dir: root };
};

test("a person's pane says why its shell is jailed, then starts it in the sandbox, its arguments read from the file and its directory its own", async () => {
    const { out, dir } = await runLine("web-a1");
    expect(out.split("\n")).toEqual([
        "Conversations here can be private, so this shell runs as node in a sandbox and /history is hidden.",
        "For a root shell, use the host (docker exec -u 0 -it <container> bash) or the container terminal of your orchestrator.",
        `bwrap --args 3 --chdir ${dir} -- zsh fd3:--ro-bind /usr /usr`,
    ]);
});

test("a daemon session's pane starts its shell as it always did, with no notice in front", async () => {
    for (const session of ["panel-site", "job-push", "agent-abc", "svc-api", "intentic-server-pin"]) {
        expect((await runLine(session)).out).toBe("zsh");
    }
});
