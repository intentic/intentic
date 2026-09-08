import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { shellQuote } from "@intentic/sandbox-run/quote";

// Every user-triggered shell action runs inside a visible tmux session in the terminals panel, never an invisible
// child_process; reads, probes, and boot plumbing are exempt. Each run is one window via bin/tmux-run: tee-captured
// output, the real exit code, secrets forwarded by name via tmux -e, never in argv or command text.

const execFileAsync = promisify(execFile);

// Baked into the image; absent in local dev/tests, where the runner falls back to a plain invisible `bash -c`.
export const TMUX_RUN_BIN = "/usr/local/bin/tmux-run";

// The agent's Bash hook wrapper for heavy commands (heavy-commands.json); holds a slot so concurrent test fan-outs take
// turns. Not used by the runner below, which is single user-triggered ops, not repeated builds.
export const QUEUE_RUN_BIN = "/usr/local/bin/queue-run";

// Off when the wrapper isn't baked in or the operator opts out; the caller that builds the agent's hooks checks this,
// same fail-open shape as tmuxRunEnabled.
export const queueRunEnabled = (): boolean => process.env["INTENTIC_AGENT_QUEUE"] !== "0" && existsSync(QUEUE_RUN_BIN);

// The stdout tail size (full output stays in the pane log), and the execFile buffer ceiling above it.
const OUTPUT_TAIL_BYTES = 262_144;
const MAX_BUFFER = 4 * 1024 * 1024;

export interface TerminalRunOptions {
    readonly cwd: string;
    // tmux window name (a safe slug); defaults to "run".
    readonly window?: string;
    // Extra env, forwarded onto the tmux window by name (`-e KEY`) so values never appear in argv or pane text.
    readonly env?: Readonly<Record<string, string>>;
    // Abort SIGTERMs the wrapper; its trap kills the tmux window, so the command dies with the caller.
    readonly signal?: AbortSignal;
    // Watchdog for a wedged command, same kill path as abort.
    readonly timeoutMs?: number;
    // Called when the wrapper is spawned, not queued; announcing too early names a tab tmux hasn't made yet.
    readonly onStarted?: () => void;
}

export interface TerminalRunResult {
    readonly code: number;
    readonly output: string;
}

export interface TerminalRunner {
    // False in the no-tmux fallback (dev/CI), callers gate their {kind:"terminal"} frame on it.
    readonly visible: boolean;
    // Throws on a non-zero exit with the output tail in the message, the common "this step must succeed" call.
    readonly run: (session: string, command: string, options: TerminalRunOptions) => Promise<string>;
    // A non-zero exit is a RESULT the caller inspects (wg-quick down before up, git config --unset's exit 5).
    readonly tryRun: (session: string, command: string, options: TerminalRunOptions) => Promise<TerminalRunResult>;
    // Any command in flight (or queued) for the session, the terminals list's running dot for job-* tabs.
    readonly running: (session: string) => boolean;
}

// Echoes the command line to the pane's own tty (not stdout, so it's excluded from captured output), so a flow of quiet
// commands doesn't leave a blank pane. Safe to print: secrets ride `env`, never the command string.
const paneEcho = (command: string): string => `{ printf '\\033[1m$ %s\\033[0m\\n' ${shellQuote(command)} > /dev/tty; } 2>/dev/null; `;

// execFile-shaped adapter over a session runner, for call sites that branch on the exit code; argv words are quoted
// into one visible command line.
export type ExecInTerminal = (file: string, args: readonly string[]) => Promise<{ readonly stdout: string }>;

export const terminalExec =
    (runner: TerminalRunner, session: string, cwd: string): ExecInTerminal =>
    async (file, args) => {
        const { code, output } = await runner.tryRun(session, [file, ...args].map(shellQuote).join(" "), { cwd, window: file });
        if (code !== 0) {
            const error = new Error(`${file} ${args.join(" ")} exited ${code}`) as Error & { code: number };
            error.code = code;
            throw error;
        }
        return { stdout: output };
    };

// Boot plumbing's contract, exempt from the visible-terminal rule: nobody watches, no job session for it.
export const directExec: ExecInTerminal = (file, args) => execFileAsync(file, [...args]);

export const createTerminalRunner = (): TerminalRunner => {
    const visible = existsSync(TMUX_RUN_BIN);
    const inFlight = new Map<string, number>();
    // Per-session queue: commands run in order, so new-window/set-option always targets the wrapper's own window.
    const queues = new Map<string, Promise<unknown>>();

    const execute = async (session: string, command: string, options: TerminalRunOptions): Promise<TerminalRunResult> => {
        options.onStarted?.();
        const env = { ...process.env, ...options.env };
        const execOptions = {
            cwd: options.cwd,
            maxBuffer: MAX_BUFFER,
            ...(options.signal !== undefined ? { signal: options.signal } : {}),
            ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
        };
        try {
            const { stdout } = visible
                ? await execFileAsync(
                      TMUX_RUN_BIN,
                      [
                          ...Object.keys(options.env ?? {}).flatMap((key) => ["-e", key]),
                          session,
                          `${paneEcho(command)}${command}`,
                          options.window ?? "run",
                      ],
                      {
                          ...execOptions,
                          env: {
                              ...env,
                              INTENTIC_RUN_FILTER: "0",
                              INTENTIC_RUN_SOFT_TIMEOUT_S: "0",
                              INTENTIC_RUN_OUTPUT_BYTES: String(OUTPUT_TAIL_BYTES),
                          },
                      },
                  )
                : await execFileAsync("bash", ["-c", command], { ...execOptions, env });
            return { code: 0, output: stdout };
        } catch (err) {
            // An abort propagates as cancellation; a string `code` is a spawn failure (ENOENT/EACCES), not a result.
            const failure = err as { code?: number | string; stdout?: string };
            if (options.signal?.aborted === true || typeof failure.code !== "number") {
                throw err;
            }
            return { code: failure.code, output: failure.stdout ?? "" };
        }
    };

    const tryRun = (session: string, command: string, options: TerminalRunOptions): Promise<TerminalRunResult> => {
        inFlight.set(session, (inFlight.get(session) ?? 0) + 1);
        const turn = (queues.get(session) ?? Promise.resolve()).then(
            () => execute(session, command, options),
            () => execute(session, command, options),
        );
        const settle = (): void => {
            const count = (inFlight.get(session) ?? 1) - 1;
            if (count <= 0) {
                inFlight.delete(session);
            } else {
                inFlight.set(session, count);
            }
            if (queues.get(session) === turn) {
                queues.delete(session);
            }
        };
        queues.set(session, turn.then(settle, settle));
        return turn;
    };

    return {
        visible,
        tryRun,
        run: async (session, command, options) => {
            const { code, output } = await tryRun(session, command, options);
            if (code !== 0) {
                const tail = output.trim().split("\n").slice(-15).join("\n");
                throw new Error(`${command} exited ${code}${tail === "" ? "" : `:\n${tail}`}`);
            }
            return output;
        },
        running: (session) => (inFlight.get(session) ?? 0) > 0,
    };
};
