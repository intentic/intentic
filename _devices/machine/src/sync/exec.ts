import { spawn } from "node:child_process";

/* RUNNING A CHILD PROCESS WITHOUT STOPPING THIS ONE, and in the mirror watcher, that distinction is the whole
 * difference between a sync that works and one that cannot.
 *
 * The watcher is not merely a process that shells out. It is also the process that HOLDS THE SSH TRANSPORT every
 * one of those children rides: the sandbox's sshd reaches this machine as a loopback listener served by this
 * agent's own event loop (tunnel.ts). `spawnSync` blocks that loop completely, so a `mutagen sync create`, a
 * `mutagen forward create` or the git bridge's `ssh` would open a TCP connection to a listener that had stopped
 * accepting, wait for a banner nobody could send, and time out. Every one of them, every time, against perfectly
 * healthy sandboxes:
 *
 *   file sync  , "unable to receive server magic number: EOF … Connection timed out during banner exchange"
 *   port mirror, "mutagen forward exited with code 1", and localhost stayed empty
 *   git bridge , the full 120s exec timeout per pass, per unreachable-looking repo listing
 *
 * A deadlock, not a flake: the command's only route to the sandbox is the loop the command is blocking. It was
 * invisible in review because each call site looked like ordinary synchronous shelling-out, and it stayed
 * invisible in the logs because every symptom reads as "the sandbox is not answering", which is exactly what the
 * user is told, about a sandbox that is up.
 *
 * So the watcher's children are spawned ASYNCHRONOUSLY, always, and the loop keeps serving the transport while
 * they run. `spawnSync` remains correct in the one-shot CLI commands (setup, status, uninstall): those processes
 * hold no listener, so nothing of theirs is waiting on them. */

export interface ExecResult {
    // null when the process was killed (our timeout, or a signal), never conflated with a real non-zero exit.
    readonly status: number | null;
    readonly stdout: string;
    readonly stderr: string;
}

export const runProcess = async (
    command: string,
    args: readonly string[],
    options: { readonly cwd?: string | undefined; readonly timeoutMs?: number | undefined } = {},
): Promise<ExecResult> =>
    await new Promise<ExecResult>((resolve) => {
        /* `windowsHide` because the watcher runs detached and therefore console-less on Windows, and Windows
         * gives a console child of a console-less process a new console WITH a window, a black window popping up
         * on an idle desktop every tick, forever. */
        const child = spawn(command, [...args], {
            ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => (stdout += chunk));
        child.stderr.on("data", (chunk: string) => (stderr += chunk));

        const timer =
            options.timeoutMs === undefined
                ? undefined
                : setTimeout(() => {
                      child.kill("SIGKILL");
                  }, options.timeoutMs);

        const settle = (status: number | null, failure?: Error): void => {
            clearTimeout(timer);
            resolve({ status, stdout, stderr: failure === undefined ? stderr : `${stderr}${failure.message}` });
        };
        // A command that could not be spawned at all (no `ssh` on PATH) is a failure with a reason, not a throw:
        // every caller here already has to handle "it did not work", and none of them can act on the difference.
        child.on("error", (error: Error) => settle(null, error));
        child.on("close", (code) => settle(code));
    });
