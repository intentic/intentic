import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { packageRoot } from "@intentic/constants/node";
import { expect, test } from "vitest";

/* Against the REAL bin/tmux-run, because what is being asserted is what the SCRIPT does with tmux, and the
 * bug it now prevents was invisible in every TypeScript-side test: the command line the hook composes was
 * always correct, and the damage was done by which namespace the wrapper's own tmux client stood in when it
 * forked the server. tmux and nsenter are stubbed so the assertion is about the calls, not about a live
 * server (and so this passes on a machine with neither installed).
 */

const execFileAsync = promisify(execFile);

const TMUX_RUN = join(packageRoot(import.meta.url), "bin", "tmux-run");

// A stub on PATH that appends its own argv to `calls` and answers the handful of queries the wrapper makes:
// a pane id from the window-creating forms, a live pane so the wait loop spins once, and one DEAD pane so the
// window sweep actually fires (it is the call that used to reach tmux through `xargs`). `nsenter` records its
// argv the same way and then EXECS the rest, so a hopped call shows up as both a nsenter line and the tmux
// line it carried: the ordering that proves the hop wrapped the client rather than replacing it.
// STATUS_BYTES, when the case below sets it, has the stub plant that exact content as the finished command's
// status file — the capture dir is the one it is handed on the `bash <dir>/runner` argv it is asked to run.
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
    // INTENTIC_TMUX_NS is dropped from the inherited environment first: these cases are ABOUT that variable, and
    // a sandbox that runs its own tmux under a namespace exports it, so "without the var" has to mean absent,
    // not merely unset by the caller.
    const { INTENTIC_TMUX_NS: _inherited, ...base } = process.env;
    await execFileAsync("bash", [TMUX_RUN, "agent-abc", "true", "probe"], {
        env: { ...base, PATH: `${dir}:${process.env["PATH"] ?? ""}`, INTENTIC_RUN_FILTER: "0", INTENTIC_RUN_SOFT_TIMEOUT_S: "0", ...env },
    }).catch(() => undefined);
    return calls();
};

test("every tmux call is made from the namespace INTENTIC_TMUX_NS names: the server a first call forks must be the daemon's, not the turn's", async () => {
    const calls = await run({ INTENTIC_TMUX_NS: "/proc/9/ns/mnt" });
    expect(calls).toContain("tmux kill-window -t @3");
    // Every tmux line is immediately preceded by the hop that carried it: including the dead-window sweep,
    // which used to reach tmux through `xargs` and so walked past any wrapper the script put around it.
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

/* A STATUS IT CANNOT READ IS A FAILURE, NEVER A CODE OF THE WRAPPER'S OWN INVENTION.
 *
 * The last line of the wrapper is `exit $code`, and bash answers anything that is not a number by complaining
 * and exiting 2 — a code the command never returned, handed back attached to the output of a command that had
 * in fact SUCCEEDED. A half-written status file was enough to reach it: the wait loop takes the file EXISTING
 * as "finished, code readable", and `> $d/status` creates it empty a moment before the digit lands, which a
 * machine running every package's suite at once has all the time in the world to schedule into. It surfaced as
 * a capability install reporting `git clone … exited 2` under two lines of ordinary clone output, once in a
 * full run and green on every re-run after.
 *
 * The write is a rename now, so the file cannot be seen half-made; this holds the READER to the same rule for
 * whatever else might truncate it (a killed pane, a full disk), because inventing a 2 is the failure that
 * costs the most: it is indistinguishable from the command having really failed.
 */
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
    // bash's own complaint about the bad argument, which is the tell that the value reached `exit` unchecked.
    expect(failure.stderr).not.toContain("numeric argument required");
    return failure.code;
};

test("a status file that is empty or not a number exits 1, the honest failure, rather than bash's invented 2", async () => {
    expect(await statusProbe("")).toBe(1);
    expect(await statusProbe("not-a-number")).toBe(1);
});
