import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { packageRoot } from "@intentic/constants/node";
import { expect, test } from "vitest";

// Runs the real bin/tmux-run with tmux and nsenter stubbed, pinning which namespace the wrapper's tmux client forks the
// server in. Passes without tmux or nsenter installed.

const execFileAsync = promisify(execFile);

const TMUX_RUN = join(packageRoot(import.meta.url), "bin", "tmux-run");

// Stub records argv to `calls`, answers pane-id/liveness/dead-pane queries, and (via nsenter) execs through so a hop
// leaves both an nsenter and tmux line; `plantStatus` writes STATUS_BYTES as the status file.
const plantStatus = `for a in "$@"; do case "$a" in "bash "*/runner) p="\${a#bash }"; [ -n "\${STATUS_BYTES+x}" ] && printf '%s' "$STATUS_BYTES" > "\${p%/runner}/status" ;; esac; done\n`;

const stubs = async (): Promise<{ dir: string; calls: () => Promise<string[]> }> => {
    const dir = await mkdtemp(join(tmpdir(), "tmux-run-"));
    const log = join(dir, "calls");
    await writeFile(
        join(dir, "tmux"),
        `#!/usr/bin/env bash\nprintf 'tmux %s\\n' "$*" >> ${JSON.stringify(log)}\ncase "$1" in\n  new-session|new-window) ${plantStatus}    echo '%7' ;;\n  list-panes) echo '1 @3' ;;\n  display) echo 1 ;;\nesac\nexit 0\n`,
        { mode: 0o755 },
    );
    await writeFile(join(dir, "nsenter"), `#!/usr/bin/env bash\nprintf 'nsenter %s\\n' "$1" >> ${JSON.stringify(log)}\nshift 2\nexec "$@"\n`, {
        mode: 0o755,
    });
    return { dir, calls: async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean) };
};

const run = async (env: Record<string, string>): Promise<string[]> => {
    const { dir, calls } = await stubs();
    // INTENTIC_TMUX_NS is stripped from the inherited env, so "without the var" means absent, not just unset.
    const { INTENTIC_TMUX_NS: _inherited, ...base } = process.env;
    await execFileAsync("bash", [TMUX_RUN, "agent-abc", "true", "probe"], {
        env: { ...base, PATH: `${dir}:${process.env["PATH"] ?? ""}`, INTENTIC_RUN_FILTER: "0", INTENTIC_RUN_SOFT_TIMEOUT_S: "0", ...env },
    }).catch(() => undefined);
    return calls();
};

test("every tmux call is made from the namespace INTENTIC_TMUX_NS names: the server a first call forks must be the daemon's, not the turn's", async () => {
    const calls = await run({ INTENTIC_TMUX_NS: "/proc/9/ns/mnt" });
    expect(calls).toContain("tmux kill-window -t @3");
    // Every tmux line is immediately preceded by the hop that carried it, including the dead-window sweep.
    for (const [index, call] of calls.entries()) {
        if (call.startsWith("tmux ")) {
            expect(calls[index - 1]).toBe("nsenter --mount=/proc/9/ns/mnt");
        }
    }
});

test("without the var the wrapper talks to tmux directly: the daemon's own runner and an unisolated turn are already where the server belongs", async () => {
    const calls = await run({});
    expect(calls.filter((call) => call.startsWith("tmux "))).not.toHaveLength(0);
    expect(calls.some((call) => call.startsWith("nsenter"))).toBe(false);
});

// The wrapper's `exit $code` turns any non-numeric status into bash's own exit 2, indistinguishable from the command
// truly failing. The status write is a rename, so the file is never read half-made.
const statusProbe = async (bytes: string): Promise<number> => {
    const { dir } = await stubs();
    const { INTENTIC_TMUX_NS: _inherited, ...base } = process.env;
    const failure = await execFileAsync("bash", [TMUX_RUN, "agent-status", "true", "probe"], {
        env: {
            ...base,
            PATH: `${dir}:${process.env["PATH"] ?? ""}`,
            INTENTIC_RUN_FILTER: "0",
            INTENTIC_RUN_SOFT_TIMEOUT_S: "0",
            STATUS_BYTES: bytes,
        },
    }).then(
        () => ({ code: 0, stderr: "" }),
        (error: { code?: number; stderr?: string }) => ({ code: error.code ?? -1, stderr: error.stderr ?? "" }),
    );
    // bash's own complaint about a bad argument is the tell that the value reached `exit` unchecked.
    expect(failure.stderr).not.toContain("numeric argument required");
    return failure.code;
};

test("a status file that is empty or not a number exits 1, the honest failure, rather than bash's invented 2", async () => {
    expect(await statusProbe("")).toBe(1);
    expect(await statusProbe("not-a-number")).toBe(1);
});
