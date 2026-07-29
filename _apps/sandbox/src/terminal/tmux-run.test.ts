import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

/* Against the REAL bin/tmux-run, because what is being asserted is what the SCRIPT does with tmux — and the
 * bug it now prevents was invisible in every TypeScript-side test: the command line the hook composes was
 * always correct, and the damage was done by which namespace the wrapper's own tmux client stood in when it
 * forked the server. tmux and nsenter are stubbed so the assertion is about the calls, not about a live
 * server (and so this passes on a machine with neither installed).
 */

const execFileAsync = promisify(execFile);

const TMUX_RUN = join(import.meta.dirname, "..", "..", "bin", "tmux-run");

// A stub on PATH that appends its own argv to `calls` and answers the handful of queries the wrapper makes:
// a pane id from the window-creating forms, a live pane so the wait loop spins once, and one DEAD pane so the
// window sweep actually fires (it is the call that used to reach tmux through `xargs`). `nsenter` records its
// argv the same way and then EXECS the rest, so a hopped call shows up as both a nsenter line and the tmux
// line it carried — the ordering that proves the hop wrapped the client rather than replacing it.
const stubs = async (): Promise<{ dir: string; calls: () => Promise<string[]> }> => {
    const dir = await mkdtemp(join(tmpdir(), "tmux-run-"));
    const log = join(dir, "calls");
    await writeFile(
        join(dir, "tmux"),
        `#!/usr/bin/env bash\nprintf 'tmux %s\\n' "$*" >> ${JSON.stringify(log)}\ncase "$1" in\n  new-session|new-window) echo '%7' ;;\n  list-panes) echo '1 @3' ;;\n  display) echo 1 ;;\nesac\nexit 0\n`,
        { mode: 0o755 },
    );
    await writeFile(join(dir, "nsenter"), `#!/usr/bin/env bash\nprintf 'nsenter %s\\n' "$1" >> ${JSON.stringify(log)}\nshift 2\nexec "$@"\n`, {
        mode: 0o755,
    });
    return { dir, calls: async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean) };
};

const run = async (env: Record<string, string>): Promise<string[]> => {
    const { dir, calls } = await stubs();
    await execFileAsync("bash", [TMUX_RUN, "agent-abc", "true", "probe"], {
        env: { ...process.env, PATH: `${dir}:${process.env["PATH"] ?? ""}`, INTENTIC_RUN_FILTER: "0", INTENTIC_RUN_SOFT_TIMEOUT_S: "0", ...env },
    }).catch(() => undefined);
    return calls();
};

test("every tmux call is made from the namespace INTENTIC_TMUX_NS names — the server a first call forks must be the daemon's, not the turn's", async () => {
    const calls = await run({ INTENTIC_TMUX_NS: "/proc/9/ns/mnt" });
    expect(calls).toContain("tmux kill-window -t @3");
    // Every tmux line is immediately preceded by the hop that carried it — including the dead-window sweep,
    // which used to reach tmux through `xargs` and so walked past any wrapper the script put around it.
    for (const [index, call] of calls.entries()) {
        if (call.startsWith("tmux ")) {
            expect(calls[index - 1]).toBe("nsenter --mount=/proc/9/ns/mnt");
        }
    }
});

test("without the var the wrapper talks to tmux directly — the daemon's own runner and an unisolated turn are already where the server belongs", async () => {
    const calls = await run({});
    expect(calls.filter((call) => call.startsWith("tmux "))).not.toHaveLength(0);
    expect(calls.some((call) => call.startsWith("nsenter"))).toBe(false);
});
