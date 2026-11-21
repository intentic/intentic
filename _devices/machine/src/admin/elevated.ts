import { errorMessage } from "@intentic/base/errors";
import { type ProcessResult, runBounded } from "@intentic/base/process";

/* A PROGRAM RUN AS AN ADMINISTRATOR, THROUGH THE ONE PROMPT THE SYSTEM SHOWS FOR IT: UAC on Windows, pkexec on Linux.
   What this agent installs that needs an administrator once goes through here: Passwords' protected service
   (keyring/service.ts) and remote access's lock-screen service (device/remote/remoted-service.ts). Each caller says the
   outcome in its own words; this module only runs the prompt and reads what came back. Windows hands nothing the elevated
   program printed back across the elevation (Start-Process -Verb RunAs cannot redirect it), so its exit code is the
   whole answer, and a caller that needs more asks the program again unelevated. */

// A person may take their time with a UAC prompt.
export const ELEVATED_TIMEOUT_MS = 10 * 60_000;

export interface ElevatedCommand {
    readonly command: string;
    readonly args: readonly string[];
}

// A PowerShell string literal: single quotes, each one inside doubled.
const psQuoted = (text: string): string => `'${text.replaceAll("'", "''")}'`;

/**
 * One argument as a Windows program reads it back from its command line (the C runtime's and Rust's rules): as it is
 * when it holds no space, tab or quote, else quoted, with a quote inside escaped and the backslashes before a quote
 * doubled. Start-Process joins its -ArgumentList with spaces and quotes nothing, so a path under `C:\Users\Jane Doe`
 * would otherwise arrive as two arguments. Pure.
 */
export const windowsArg = (arg: string): string => {
    if (arg !== "" && !/[\s"]/u.test(arg)) {
        return arg;
    }
    return `"${arg.replaceAll(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, "$1$1")}"`;
};

/**
 * `binary args` run as an administrator: UAC on Windows, pkexec on Linux. Pure. On Windows the elevated program is a
 * console program, which ShellExecute would give a console window of its own: `-WindowStyle Hidden` keeps that window
 * off the screen, so the person sees the UAC prompt and nothing else.
 */
export const elevatedRun = (binary: string, args: readonly string[], platform: NodeJS.Platform = process.platform): ElevatedCommand =>
    platform === "win32"
        ? {
              command: "powershell.exe",
              args: [
                  "-NoProfile",
                  "-NonInteractive",
                  "-WindowStyle",
                  "Hidden",
                  "-Command",
                  `$p = Start-Process -FilePath ${psQuoted(binary)} -ArgumentList ${args.map((arg) => psQuoted(windowsArg(arg))).join(",")} -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode`,
              ],
          }
        : { command: "pkexec", args: [binary, ...args] };

/**
 * A script run as an administrator, through the one prompt the system shows for it: Windows PowerShell started elevated
 * with the script encoded (UTF-16LE base64, as -EncodedCommand takes it), or sh under pkexec. Pure.
 */
export const elevatedScriptCommand = (script: string, platform: NodeJS.Platform = process.platform): ElevatedCommand =>
    platform === "win32"
        ? {
              command: "powershell.exe",
              args: [
                  "-NoProfile",
                  "-NonInteractive",
                  "-WindowStyle",
                  "Hidden",
                  "-Command",
                  `$p = Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-NonInteractive','-WindowStyle','Hidden','-EncodedCommand',${psQuoted(Buffer.from(script, "utf16le").toString("base64"))} -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode`,
              ],
          }
        : { command: "pkexec", args: ["sh", "-c", script] };

/**
 * Whether an elevated run's failure was the administrator's yes not given: UAC's "canceled by the user", pkexec's 126
 * (dialog dismissed) and 127 (not authorized). Pure.
 */
export const approvalRefused = (exitCode: number | null, said: string, platform: NodeJS.Platform = process.platform): boolean =>
    platform === "win32" ? /canceled by the user/iu.test(said) : exitCode === 126 || exitCode === 127;

/** How an elevated run ended: done, never shown (the prompt's own program would not start), declined, or failed. */
export type ElevatedOutcome =
    | { readonly kind: "done" }
    | { readonly kind: "unstarted"; readonly why: string }
    | { readonly kind: "declined" }
    | { readonly kind: "failed"; readonly exitCode: number | null; readonly said: string; readonly timedOut: boolean };

type Runner = (command: string, args: readonly string[], options: { readonly timeoutMs: number }) => Promise<ProcessResult>;

/** `elevated` run, waiting up to ELEVATED_TIMEOUT_MS for the person to answer the prompt, and its ending read. */
export const runAsAdministrator = async (
    elevated: ElevatedCommand,
    run: Runner = runBounded,
    platform: NodeJS.Platform = process.platform,
): Promise<ElevatedOutcome> => {
    const result = await run(elevated.command, elevated.args, { timeoutMs: ELEVATED_TIMEOUT_MS });
    if (result.spawnError !== undefined) {
        return { kind: "unstarted", why: `${elevated.command} could not be started: ${errorMessage(result.spawnError)}` };
    }
    if (result.exitCode === 0) {
        return { kind: "done" };
    }
    const said = result.stderr.text.trim();
    return approvalRefused(result.exitCode, said, platform) ? { kind: "declined" } : { kind: "failed", exitCode: result.exitCode, said, timedOut: result.timedOut };
};
