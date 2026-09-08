// Two shapes: `run` takes an argv with no shell, so an argument can't be re-parsed; `powershell` runs a script under
// PowerShell 5.1 (not 7), matching what the app and the install one-liner spawn. Scripts go in as -EncodedCommand
// (UTF-16LE base64) so a bad quote fails silently rather than throwing.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface RunResult {
    readonly code: number;
    readonly stdout: string;
    readonly stderr: string;
}

export interface RunOptions {
    readonly cwd?: string;
    readonly env?: Record<string, string>;
    readonly timeoutMs?: number;
    /** Bytes of output to keep; installers and container logs can be verbose, so the default is generous. */
    readonly maxBuffer?: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;
const DEFAULT_MAX_BUFFER = 32 * 1024 * 1024;

// Non-zero exit is a result, never a throw: every caller here asks a question that may legitimately answer no. Same
// choice the Linux tier makes with `|| true`.
export const run = async (file: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> => {
    try {
        const { stdout, stderr } = await execFileAsync(file, [...args], {
            cwd: options.cwd,
            env: options.env === undefined ? process.env : { ...process.env, ...options.env },
            timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
            windowsHide: true,
        });
        return { code: 0, stdout, stderr };
    } catch (error) {
        const failure = error as NodeJS.ErrnoException & { code?: number | string; stdout?: string; stderr?: string };
        // `code` is a number for a process that ran, an errno string for one that never started; both are failures.
        const code = typeof failure.code === `number` ? failure.code : 127;
        return { code, stdout: failure.stdout ?? ``, stderr: failure.stderr ?? String(failure.message ?? error) };
    }
};

/** Script text as PowerShell's -EncodedCommand wants it; pure, so the encoding is tested, not trusted. */
export const encodeCommand = (script: string): string => Buffer.from(script, `utf16le`).toString(`base64`);

export const powershell = async (script: string, options: RunOptions = {}): Promise<RunResult> =>
    await run(
        `powershell.exe`,
        // -NoProfile: a machine's profile isn't part of the product; -NonInteractive fails a hang loudly instead.
        [`-NoProfile`, `-NonInteractive`, `-ExecutionPolicy`, `Bypass`, `-EncodedCommand`, encodeCommand(script)],
        options,
    );
