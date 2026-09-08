import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { agentShellBusy } from "./agent-terminals.js";

// Runs against a real tmux server: the dead-vs-running window distinction (remain-on-exit) needs a real process, not a
// stub.
// A `tmux` shim on PATH redirects to a private socket; TMUX_TMPDIR is ignored by tmux 3.3a.

const execFileAsync = promisify(execFile);

let dir: string | undefined;
let path: string | undefined;

// One private tmux server per case; `tmux` on PATH is the shim, so the probe, fixtures and teardown reach the same
// socket.
const server = async (): Promise<{ tmux: (...args: string[]) => Promise<void> }> => {
    // Resolved before the shim replaces `tmux` on PATH: it needs the real binary's absolute path.
    const { stdout: binary } = await execFileAsync("sh", ["-c", "command -v tmux"]);
    dir = await mkdtemp(join(tmpdir(), "agent-shell-"));
    await writeFile(join(dir, "tmux"), `#!/usr/bin/env bash\nexec ${JSON.stringify(binary.trim())} -S ${JSON.stringify(join(dir, "sock"))} "$@"\n`, {
        mode: 0o755,
    });
    path = process.env["PATH"];
    process.env["PATH"] = `${dir}:${path ?? ""}`;
    return { tmux: async (...args: string[]) => void (await execFileAsync("tmux", args)) };
};

afterEach(async () => {
    if (dir === undefined) {
        return;
    }
    await execFileAsync("tmux", ["kill-server"]).catch(() => undefined);
    process.env["PATH"] = path ?? "";
    await rm(dir, { recursive: true, force: true });
    dir = undefined;
});

// The sdk session id the tmux session is named off: agentSessionName takes its first eight characters.
const SESSION_ID = "abcd1234-0000-0000-0000-000000000000";

const settle = async (until: () => Promise<boolean>): Promise<void> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (await until()) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
};

test("a command still running in the turn's session is busy", async () => {
    const { tmux } = await server();
    await tmux("new-session", "-d", "-s", "agent-abcd1234", "sleep 30");

    expect(await agentShellBusy(SESSION_ID)).toBe(true);
});

test("a session whose commands have all finished is not busy", async () => {
    const { tmux } = await server();
    // Started only so `set-option -g` has a target; remain-on-exit must be set before the tracked window exits.
    await tmux("new-session", "-d", "-s", "boot", "sleep 30");
    await tmux("set-option", "-g", "remain-on-exit", "on");
    await tmux("new-session", "-d", "-s", "agent-abcd1234", "true");
    await settle(async () => !(await agentShellBusy(SESSION_ID)));

    expect(await agentShellBusy(SESSION_ID)).toBe(false);
});

// tmux exits non-zero when there is no session for the turn; that must count as not busy, like all-finished.
test("a turn that opened no shell is not busy", async () => {
    const { tmux } = await server();
    await tmux("new-session", "-d", "-s", "agent-99999999", "sleep 30");

    expect(await agentShellBusy(SESSION_ID)).toBe(false);
});

test("no tmux server at all is not busy", async () => {
    await server();

    expect(await agentShellBusy(SESSION_ID)).toBe(false);
});

// An id that sanitizes to nothing names no session.
test("an unnameable session id is not busy", async () => {
    await server();

    expect(await agentShellBusy("///")).toBe(false);
});
