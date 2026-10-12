import { errorMessage } from "@intentic/base/errors";
import { execBounded, runBounded } from "@intentic/base/process";

// Runs commands in a fresh shell, not this process's env: this sandbox's own `CONNECT_TOKEN` would silently outrank the
// claim's `.env` and start a box with the wrong credential. An allowlist, not a denylist, since a denylist is only as
// good as the next compose-file variable; the CLI lane shares the same floor.

const PASS_THROUGH = [`PATH`, `HOME`, `DOCKER_HOST`, `DOCKER_CONFIG`, `DOCKER_CERT_PATH`, `DOCKER_TLS_VERIFY`, `XDG_RUNTIME_DIR`];

export const freshShellEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
    ...Object.fromEntries(PASS_THROUGH.flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]]))),
    ...extra,
});

/** A command the wizard rendered, run in a folder, failing with what it printed. */
export const sh = async (command: string, cwd: string, what: string, timeoutMs = 300_000): Promise<string> => {
    try {
        const { stdout, stderr } = await execBounded(`sh`, [`-c`, command], {
            cwd,
            env: freshShellEnv(),
            timeoutMs,
            maxOutput: 32 * 1024 * 1024,
        });
        return `${stdout}${stderr}`;
    } catch (cause) {
        const message = errorMessage(cause);
        throw new Error(`${what} failed: ${message}`, { cause });
    }
};

export interface Completed {
    /** The exit status. -1 when the process was killed (a timeout) rather than exiting on its own. */
    readonly code: number;
    /** stdout, then stderr. */
    readonly output: string;
}

// A non-zero exit is an answer here, not a throw, unlike `sh` above, which drops the output a failed exec needs
// explained. The CLI lane must read what the checklist printed to tell an expected failure from a real one. A program
// that could not be started at all is still a throw: there is no answer to read.
export const runTool = async (
    file: string,
    args: readonly string[],
    options: { readonly env: Record<string, string>; readonly timeoutMs: number },
): Promise<Completed> => {
    const result = await runBounded(file, args, { env: options.env, timeoutMs: options.timeoutMs });
    if (result.spawnError !== undefined) {
        throw result.spawnError;
    }
    return { code: result.exitCode ?? -1, output: `${result.stdout.text}${result.stderr.text}` };
};
