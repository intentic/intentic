import { runBounded, runBoundedSync } from "@intentic/base/process";

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
// still holds the pipes, and it keeps each stream's output in bounded memory.
export const runProcess = async (
    command: string,
    args: readonly string[],
    options: { readonly cwd?: string | undefined; readonly timeoutMs?: number | undefined } = {},
): Promise<ExecResult> => {
    const result = await runBounded(command, args, { cwd: options.cwd, timeoutMs: options.timeoutMs ?? CHILD_TIMEOUT_MS });
    // A spawn failure (e.g. a missing binary) resolves as a failed result with its reason after stderr, not a throw.
    const failure = result.spawnError?.message ?? "";
    return { status: result.exitCode, stdout: result.stdout.text, stderr: `${result.stderr.text}${failure}` };
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
        env: options.env,
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
