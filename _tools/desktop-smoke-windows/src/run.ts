/* Running things on the machine under test, and the one encoding decision that keeps it honest.
 *
 * Two shapes, and the difference between them matters:
 *
 *   `run`        — a program with an argument vector. No shell, so nothing this file passes can be re-parsed
 *                  by anything: a sandbox hostname with a space in it is one argument, not two.
 *   `powershell` — a SCRIPT, handed to Windows PowerShell 5.1.
 *
 * 5.1 (`powershell.exe`) and not 7 (`pwsh.exe`), everywhere, because that is what the desktop app spawns and
 * what the site's one-liner lands in. A tier that verified the shipped scripts under 7 would be testing a
 * shell no user of this product runs — and the two differ in exactly the places these scripts live: native
 * stderr redirection under `$ErrorActionPreference = 'Stop'`, and `$PSNativeCommandUseErrorActionPreference`,
 * both of which `connect.ps1` opens by disarming.
 *
 * -EncodedCommand rather than -Command: the argument reaches PowerShell as UTF-16LE base64, so quoting is not
 * a thing that exists on the way in. Passing a script as text means every embedded quote is negotiated by
 * CreateProcess's own parser and then again by PowerShell's, and the failures that produces are silent — a
 * probe that returns the empty string reads exactly like a probe that returned "no".
 */

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
    /** Bytes of output to keep. Installers and container logs can be verbose; the default is generous. */
    readonly maxBuffer?: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;
const DEFAULT_MAX_BUFFER = 32 * 1024 * 1024;

/* A non-zero exit is a RESULT, never a throw. Every caller here is asking a question the answer to which may
 * legitimately be "no" — is docker there, did the installer succeed, does the registry hold that key — and a
 * helper that threw would turn each of them into a try/catch at the call site. The Linux tier makes the same
 * choice with `|| true`; this is the same decision spelled once. */
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
        // `code` is the exit status for a process that ran, and an errno string ("ENOENT") for one that never
        // started. Both are failures; only the first has a number to report.
        const code = typeof failure.code === `number` ? failure.code : 127;
        return { code, stdout: failure.stdout ?? ``, stderr: failure.stderr ?? String(failure.message ?? error) };
    }
};

/** The script text, as PowerShell's `-EncodedCommand` wants it. Pure, so the encoding is tested rather than trusted. */
export const encodeCommand = (script: string): string => Buffer.from(script, `utf16le`).toString(`base64`);

export const powershell = async (script: string, options: RunOptions = {}): Promise<RunResult> =>
    await run(
        `powershell.exe`,
        // -NoProfile: a machine's profile is not part of the product. -NonInteractive so a script that asks a
        // question fails loudly here instead of hanging until the job's timeout.
        [`-NoProfile`, `-NonInteractive`, `-ExecutionPolicy`, `Bypass`, `-EncodedCommand`, encodeCommand(script)],
        options,
    );
