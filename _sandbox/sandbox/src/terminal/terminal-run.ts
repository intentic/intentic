import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { shellQuote } from "@intentic/sandbox-run/quote";

// THE PRINCIPLE: every real shell action the daemon executes for a user-triggered flow runs inside a visible
// tmux session surfaced in the app's terminals panel, no invisible child_process for user actions. Reads,
// probes and boot plumbing are exempt. A new flow picks a `job-*` session (terminal-session.ts), emits
// {kind:"terminal", session} as its stream's first frame (gated on `visible`), and runs every command through
// this runner. Secrets ride the `env` option, forwarded as name-only tmux `-e` flags the wrapper resolves
// from its own environment, never the command string or any argv: pane text is persisted to the pane logs
// (logs/log-files.ts), so anything printed is written to disk.
//
// Each run is one window of the session via bin/tmux-run (the same wrapper the agent's Bash hook uses):
// tee-captured output, status-file completion, the command's real exit code. Finished windows linger for
// scrollback until the session's next run prunes them; sessions linger attachable until the boot sweep
// (managed-processes.ts killStaleManagedSessions) or the user × them.
//
// The BROWSER half of the same rule, what a surface may do with the output once it has a session, and the two
// text surfaces that are exceptions to it, is stated at the seam that opens them:
// _editor/web/src/composables/terminal/useTerminalPanel.ts. A flow is only half-visible if the daemon runs it
// here and the client still paints a captured tail into a box.

const execFileAsync = promisify(execFile);

// Where the image bakes the wrapper (Dockerfile). Absent in local dev/tests, the runner then degrades to a
// plain invisible `bash -c` with the same result contract, and `visible` gates the terminal frames.
export const TMUX_RUN_BIN = "/usr/local/bin/tmux-run";

// What ships back over the wrapper's stdout (the tail, full output stays in the pane + pane log), and the
// execFile ceiling above it.
const OUTPUT_TAIL_BYTES = 262_144;
const MAX_BUFFER = 4 * 1024 * 1024;

export interface TerminalRunOptions {
    readonly cwd: string;
    // tmux window name (a safe slug); defaults to "run".
    readonly window?: string;
    // Extra env for the command, set on the wrapper's own env (what the no-tmux fallback sees) and forwarded
    // onto the tmux window by NAME (`-e KEY`), so values never appear in any argv or pane text.
    readonly env?: Readonly<Record<string, string>>;
    // Abort SIGTERMs the wrapper; its trap kills the tmux window, so the command dies with the caller.
    readonly signal?: AbortSignal;
    // Watchdog for a wedged command, same kill path as abort.
    readonly timeoutMs?: number;
    /* Called when this command LEAVES THE QUEUE and the wrapper is spawned, i.e. when its tmux window is
     * being created, milliseconds away, rather than at some unknown later point behind whatever else the
     * session is running. For the one caller that has to tell a browser where to look: a session name handed
     * out while the command is still queued sends it to a tab tmux has not created yet. */
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
    // Any command in flight (or queued) for the session, the terminals list's `running` dot for job-* tabs.
    readonly running: (session: string) => boolean;
}

// What the PANE shows before the command runs, the line itself, the way a terminal echoes what you typed.
// Without it a flow of quiet commands (`git config`, a credential write) leaves a blank pane, and the terminal
// the app just opened for the user reads as "nothing happened here" even though the install ran in it.
// Written to the pane's own tty rather than to stdout, so it stays out of the captured output the caller gets
// back (an error message's tail, an ACP agent's tool result), and the whole line is swallowed where there is
// no tty, which is the no-tmux fallback. Safe to print by the runner's standing invariant: secrets ride `env`,
// never the command string.
const paneEcho = (command: string): string => `{ printf '\\033[1m$ %s\\033[0m\\n' ${shellQuote(command)} > /dev/tty; } 2>/dev/null; `;

// execFile-shaped adapter over a session runner, for call sites written against `exec(file, args)` that branch
// on the exit code (git config --unset's expected 5): non-zero throws with `code` set, argv words are quoted
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

// The same contract for boot plumbing, which the visible-terminal principle above exempts: a restore runs with
// nobody watching and no job session to surface it in, so it goes straight through execFile, including the
// numeric exit `code` callers branch on (git config --unset's 5).
export const directExec: ExecInTerminal = (file, args) => execFileAsync(file, [...args]);

export const createTerminalRunner = (): TerminalRunner => {
    const visible = existsSync(TMUX_RUN_BIN);
    const inFlight = new Map<string, number>();
    // Per-session promise chain: commands in one session run strictly in order, so the wrapper's
    // `new-window ; set-option` pair always targets its own window and the pane reads as a sequence.
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
            // An abort is the caller's cancellation (propagate as such), and a string code is a spawn failure
            // (ENOENT/EACCES), an infra error, not a command result.
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
