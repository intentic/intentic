import { spawn } from "node:child_process";

// Children of the mirror watcher spawn asynchronously: spawnSync would block the event loop serving the SSH transport
// (tunnel.ts) they ride, deadlocking every sync/forward/git-bridge call. spawnSync remains correct for one-shot CLI
// commands (setup, status, uninstall), which hold no listener.

export interface ExecResult {
    // Null when the process was killed by timeout or signal; never a real exit code.
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
        // windowsHide avoids Windows popping a console window for a child of this console-less detached process.
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
        // Spawn failure (e.g. missing binary) resolves as a failed result, not a throw.
        child.on("error", (error: Error) => settle(null, error));
        child.on("close", (code) => settle(code));
    });
