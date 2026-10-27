import { runCheck } from "../../../workload/run-check.js";

export const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

// Inherit binaries, never another turn's credentials, proxies, SSH agent or git config.
const commandEnv = (home: string, extra: Readonly<Record<string, string>> = {}) => ({
    PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: `${home}/.config`,
    LANG: "C.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/false",
    SSH_ASKPASS: "/bin/false",
    GIT_SSH_COMMAND: "/bin/false",
    ...extra,
});

export interface CommandResult {
    readonly stdout: string;
    readonly stderr: string;
    readonly code: number;
}

export const runCommand = async (
    command: string,
    options: { readonly home: string; readonly cwd?: string; readonly env?: Readonly<Record<string, string>>; readonly input?: string | undefined },
): Promise<CommandResult> => {
    const result = await runCheck({
        argv: ["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", command],
        cwd: options.cwd ?? options.home,
        env: commandEnv(options.home, options.env),
        stdin: options.input ?? "",
        // A timeout bounds a hung client; it is not a speed assertion.
        timeoutMs: 30_000,
        workload: { class: "command" },
        kind: "probe",
        captureBytes: 8 * 1024 * 1024,
        killOnOverflow: true,
    });
    const stopped = result.spawnError ?? result.ended ?? result.exitSignal;
    if (stopped !== undefined) {
        throw new Error(`conformance command stopped: ${stopped}`);
    }
    return { stdout: result.stdout, stderr: result.stderr, code: result.exitCode ?? -1 };
};

export const successful = async (result: Promise<CommandResult>): Promise<string> => {
    const answer = await result;
    expect(answer.code, answer.stderr).toBe(0);
    return answer.stdout;
};

// HOME is process-wide for daemon file writes; scenarios run sequentially in their own suite process.
export const inHome = async <T>(home: string, action: () => Promise<T>): Promise<T> => {
    const previous = process.env["HOME"];
    process.env["HOME"] = home;
    try {
        return await action();
    } finally {
        if (previous === undefined) {
            delete process.env["HOME"];
        } else {
            process.env["HOME"] = previous;
        }
    }
};
