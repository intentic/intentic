import { runBounded, runBoundedSync } from "@intentic/base/process";
import { childEnv } from "./mutagen-env.js";

// Children of the mirror watcher spawn asynchronously: spawnSync would block the event agent serving the SSH transport
// (tunnel.ts) they ride, deadlocking every sync/forward/git-bridge call. A blocking call remains correct for a local
// one (a Mutagen listing, a terminate) from a caller that cannot await, and for the one-shot CLI commands (setup,
// status, uninstall), which hold no listener: those go through runProcessSync below, never a bare spawnSync.

export interface ExecResult {
    // Null when the process was killed by timeout or signal; never a real exit code.
    readonly status: number | null;
    readonly stdout: string;
    readonly stderr: string;
}

// THE BOUND EVERY CHILD HAS, whatever its caller forgot: a child that never exits holds the watcher's whole pass with
// it (every pairing after it, the reports, the heartbeat), and the old default here was no bound at all. Generous,
// since the callers that know their work set their own, shorter ones; this only turns "forever" into "a long while".
export const CHILD_TIMEOUT_MS = 10 * 60_000;

// The shared runner holds the rest of the bound: at the deadline it ends the child's whole process group (an ssh a
// mutagen or git started goes with it), it settles once the child has exited even while something it left behind
// still holds the pipes, and it keeps each stream's output in bounded memory. A Mutagen child gets this agent's own
// Mutagen environment unless the caller hands it another (mutagen-env.ts).
export const runProcess = async (
    command: string,
    args: readonly string[],
    options: { readonly cwd?: string | undefined; readonly timeoutMs?: number | undefined; readonly env?: NodeJS.ProcessEnv | undefined } = {},
): Promise<ExecResult> => {
    const result = await runBounded(command, args, {
        cwd: options.cwd,
        env: childEnv(command, options.env),
        timeoutMs: options.timeoutMs ?? CHILD_TIMEOUT_MS,
    });
    // A spawn failure (e.g. a missing binary) resolves as a failed result with its reason after stderr, not a throw.
    const failure = result.spawnError?.message ?? "";
    return { status: result.exitCode, stdout: result.stdout.text, stderr: `${result.stderr.text}${failure}` };
};

// How a watched command ended: by itself, gone quiet past its allowance, still going at its ceiling, or stopped by the
// caller's signal.
export type WatchedEnding = "exited" | "stalled" | "ceiling" | "stopped";

export interface WatchedResult extends ExecResult {
    readonly ending: WatchedEnding;
}

// How often a watched command's silence is measured; a fraction of any allowance worth setting.
const QUIET_CHECK_MS = 5_000;

// A COMMAND THAT MAY TAKE AS LONG AS IT KEEPS MOVING (2026-10-18). A fixed deadline is wrong for the one long job here,
// a git fetch of a repository's whole history: generous for a small repo, it cut off a big one at a home connection's
// speed every time, and git leaves the pack it was receiving on the disk when it is killed. The fetch that never fit was
// started again from nothing on the next pass, and a laptop's drive filled with abandoned packs. Watched instead: the
// command is stopped once neither stream has said anything for `quietMs` (git with `--progress` reports several times a
// second while data moves), and in any case at `ceilingMs`. The whole process tree goes, as with every bound here.
export const runWatched = async (
    command: string,
    args: readonly string[],
    options: { readonly cwd?: string | undefined; readonly quietMs: number; readonly ceilingMs: number; readonly signal?: AbortSignal | undefined },
): Promise<WatchedResult> => {
    const stop = new AbortController();
    const relay = (): void => stop.abort();
    if (options.signal?.aborted === true) {
        stop.abort();
    }
    options.signal?.addEventListener("abort", relay, { once: true });
    let heard = Date.now();
    let stalled = false;
    const quiet = setInterval(
        () => {
            if (Date.now() - heard >= options.quietMs) {
                stalled = true;
                stop.abort();
            }
        },
        Math.min(QUIET_CHECK_MS, options.quietMs),
    );
    try {
        const result = await runBounded(command, args, {
            cwd: options.cwd,
            timeoutMs: options.ceilingMs,
            signal: stop.signal,
            onSpawn: (child) => {
                const mark = (): void => {
                    heard = Date.now();
                };
                child.stdout?.on("data", mark);
                child.stderr?.on("data", mark);
            },
        });
        const failure = result.spawnError?.message ?? "";
        const ending: WatchedEnding = result.timedOut ? "ceiling" : stalled ? "stalled" : result.aborted ? "stopped" : "exited";
        return { status: result.exitCode, stdout: result.stdout.text, stderr: `${result.stderr.text}${failure}`, ending };
    } finally {
        clearInterval(quiet);
        options.signal?.removeEventListener("abort", relay);
    }
};

// spawnSync's own answer, as the blocking callers here already read it: `error` is set for a command that could not
// start and for one stopped at its deadline (`code` ETIMEDOUT), as spawnSync sets it.
export interface SyncExecResult extends ExecResult {
    readonly error?: Error;
}

// THE BLOCKING DOOR, for a caller that cannot await. The deadline is required, and it ends the command's whole process
// group (a shell's, Mutagen's, PowerShell's children with it), where spawnSync's own `timeout` signals only the direct
// child and leaves the rest running.
export const runProcessSync = (
    command: string,
    args: readonly string[],
    options: { readonly timeoutMs: number; readonly cwd?: string | undefined; readonly env?: NodeJS.ProcessEnv | undefined; readonly quiet?: boolean },
): SyncExecResult => {
    const result = runBoundedSync(command, args, {
        timeoutMs: options.timeoutMs,
        cwd: options.cwd,
        env: childEnv(command, options.env),
        output: options.quiet === true ? "ignore" : "pipe",
    });
    const stopped = result.timedOut
        ? Object.assign(new Error(`${command} ran past its ${options.timeoutMs} ms deadline and was stopped`), { code: "ETIMEDOUT" })
        : result.overflowed
          ? Object.assign(new Error(`${command} printed more than it may and was stopped`), { code: "ENOBUFS" })
          : undefined;
    const error = result.spawnError ?? stopped;
    const answer = { status: result.exitCode, stdout: result.stdout.text, stderr: result.stderr.text };
    return error === undefined ? answer : { ...answer, error };
};
