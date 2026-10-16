import { errnoCode } from "@intentic/base/errors";
import { runBounded } from "@intentic/base/process";

// Every program the keyring starts (a prompt, a password manager's CLI, PowerShell, adb, xdotool) goes through one
// Runner, so a test stands it up with a fake and the one rule that matters is kept in one place: a value, a passphrase or
// a token never rides a command line, which every process of this user can read (`ps`, /proc/<pid>/cmdline, WMI). It
// goes on standard input or in the child's environment; `args` carries names, paths and references only.

export interface RunRequest {
    readonly command: string;
    // Never a secret: see above.
    readonly args: readonly string[];
    // Written to the child's standard input, which is then closed. Where a secret goes.
    readonly input?: string;
    // Added to this process's environment for the child alone. The other place a secret may go.
    readonly env?: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
}

export interface RunAnswer {
    // Null when the program was stopped, or never started.
    readonly exitCode: number | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly timedOut: boolean;
    // The program is not installed (or not on PATH).
    readonly missing: boolean;
    // Why it could not be started at all, when it could not.
    readonly startError: string | undefined;
}

export type Runner = (request: RunRequest) => Promise<RunAnswer>;

// A prompt or a CLI answers in a few lines; anything past this is not an answer worth keeping in memory.
const MAX_OUTPUT = 1024 * 1024;

export const realRunner: Runner = async (request) => {
    const result = await runBounded(request.command, request.args, {
        input: request.input,
        env: request.env === undefined ? undefined : { ...process.env, ...request.env },
        timeoutMs: request.timeoutMs,
        maxOutput: MAX_OUTPUT,
    });
    return {
        exitCode: result.exitCode,
        stdout: result.stdout.text,
        stderr: result.stderr.text,
        timedOut: result.timedOut,
        missing: result.spawnError !== undefined && errnoCode(result.spawnError) === "ENOENT",
        startError: result.spawnError?.message,
    };
};

// Whether a run ended the way a program that did its job ends.
export const succeeded = (answer: RunAnswer): boolean => answer.exitCode === 0 && !answer.timedOut && answer.startError === undefined;

// The first line a program said on stderr, cut short and with every secret it was handed blanked out: a CLI that
// echoes what it was given into an error must not carry it into a refusal, a log or the audit.
export const firstLineScrubbed = (text: string, secrets: readonly string[]): string => {
    let line = text.split(/\r?\n/u).find((candidate) => candidate.trim() !== "") ?? "";
    for (const secret of secrets.filter((candidate) => candidate !== "")) {
        if (line.includes(secret)) {
            // A secret too short to blank out without blanking ordinary words: the line is not shown at all.
            if (secret.length < 4) {
                return "(its message is not shown: it may hold what it was given)";
            }
            line = line.split(secret).join("…");
        }
    }
    line = line.trim();
    return line.length > 200 ? `${line.slice(0, 200)}…` : line;
};
