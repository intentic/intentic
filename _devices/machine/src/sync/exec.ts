import { runBounded } from "@intentic/base/process";

// Children of the mirror watcher spawn asynchronously: spawnSync would block the event agent serving the SSH transport
// (tunnel.ts) they ride, deadlocking every sync/forward/git-bridge call. spawnSync remains correct for one-shot CLI
// commands (setup, status, uninstall), which hold no listener.

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
