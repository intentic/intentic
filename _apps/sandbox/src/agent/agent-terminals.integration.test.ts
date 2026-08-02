import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { agentShellBusy } from "./agent-terminals.js";

/* Against a REAL tmux server, because the whole gate rests on one tmux behaviour and nothing else: a window
 * whose command has exited stays listed as a DEAD pane (tmux-run sets remain-on-exit from inside it) while a
 * window whose command is still running does not. Stub that answer and the test asserts the stub.
 *
 * The server is PRIVATE, reached through a `tmux` shim on PATH that adds `-S <temp socket>` — the probe under
 * test shells out to a bare `tmux`, and this is the only seam that can redirect it without a socket parameter
 * existing in production code for the sake of a test. TMUX_TMPDIR looks like the obvious answer and is not:
 * tmux 3.3a ignores it, silently, and the sessions land on the machine's shared server — which on this sandbox
 * is the one every live agent's shell is in.
 */

const execFileAsync = promisify(execFile);

let dir: string | undefined;
let path: string | undefined;

// One private server per case, taken down whatever the case did. `tmux` on PATH is the shim from here on, so
// the probe under test, the fixtures below and the teardown all reach the same socket.
const server = async (): Promise<{ tmux: (...args: string[]) => Promise<void> }> => {
    // Resolved BEFORE the shim goes on PATH: from the next lines on `tmux` IS the shim, so it has to name the
    // real binary by absolute path to reach past itself. Looked up rather than hardcoded to /usr/bin/tmux —
    // that is Debian's answer, and a missing tmux should say so here rather than as a bash line-2 diagnostic.
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

// The sdk session id the tmux session is named off — agentSessionName takes its first eight characters.
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

/* The case the gate exists to tell apart from the one above: the agent ran commands this turn, so its session
 * is there and its windows are still listed, but every one of them has finished. That is a quiet worktree, and
 * the rebase is free to take it. */
test("a session whose commands have all finished is not busy", async () => {
    const { tmux } = await server();
    // A session the probe does not look at, to start the server — `set-option -g` needs one to exist, and
    // remain-on-exit has to be on BEFORE the command under test exits or its window is simply gone.
    await tmux("new-session", "-d", "-s", "boot", "sleep 30");
    await tmux("set-option", "-g", "remain-on-exit", "on");
    await tmux("new-session", "-d", "-s", "agent-abcd1234", "true");
    await settle(async () => !(await agentShellBusy(SESSION_ID)));

    expect(await agentShellBusy(SESSION_ID)).toBe(false);
});

// A turn that has run no Bash has no session of its own, and tmux answers that with a non-zero exit. It means
// the same thing as "everything finished" and must not read as busy — that would skip the sync on every turn
// that only ever read and asked, which is most of the turns that ask.
test("a turn that opened no shell is not busy", async () => {
    const { tmux } = await server();
    await tmux("new-session", "-d", "-s", "agent-99999999", "sleep 30");

    expect(await agentShellBusy(SESSION_ID)).toBe(false);
});

test("no tmux server at all is not busy", async () => {
    await server();

    expect(await agentShellBusy(SESSION_ID)).toBe(false);
});

// An id that sanitizes to nothing names no session, so there is nothing to ask about.
test("an unnameable session id is not busy", async () => {
    await server();

    expect(await agentShellBusy("///")).toBe(false);
});
