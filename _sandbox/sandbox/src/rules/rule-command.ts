import type { Services } from "../composition.js";
import { plainText } from "../terminal/plain-text.js";

/* RUNNING ONE RULE'S COMMAND, the engine under every `command` action, lifted out of the pre-push check
 * because the check was the only thing that had one and `turn.ending` needs the same guarantees.
 *
 * What is worth lifting is not the spawn, it is the four things around it that took the pre-push check
 * several iterations to get right, and that a second implementation would have got wrong again:
 *
 *   A REAL TERMINAL. Every shell command the daemon runs on a user's behalf is a tmux window (terminal-run.ts),
 *   so the output the owner watches is a terminal's, colour, carriage returns, a runner rewriting its own
 *   progress line. The alternative is a text box that cannot show what a test runner actually prints.
 *
 *   A CEILING THAT IS NEVER A PASS. A command that did not finish has said nothing about the work. Timing out
 *   into `failed` rather than into silence is the whole reason the ceiling exists.
 *
 *   A KILL THAT KNOWS WHY IT HAPPENED. A cancel and a timeout produce the same rejection and mean opposite
 *   things to whoever is waiting, so the two are distinguished HERE, where the difference is still visible,
 *   rather than reconstructed by every caller.
 *
 *   OUTPUT THAT CAN BE QUOTED. What comes back is the plain-text TAIL, a suite's verdict and its failure
 *   summary are at the end, and the text is going into a prompt a model reads, so a runner's escape codes are
 *   resolved away before the cap rather than pasted into it.
 *
 * It holds no state of its own. Who may run, when, and what happens to the answer belongs to the moment, the
 * push has a dialog waiting on it, a turn ending has a model waiting on it, and those are not the same job. */

// What comes back. `passed`/`failed` are verdicts about the work; `error` means the command never ran at all
// (no shell, an unreadable cwd, a missing wrapper) and so has said nothing anyone should be sent to fix.
export interface RuleCommandRun {
    readonly status: "passed" | "failed" | "error" | "cancelled";
    readonly exitCode?: number;
    readonly timedOut?: boolean;
    readonly output: string;
}

export type RuleCommandDeps = Pick<Services, "logger" | "terminalRun">;

export interface RuleCommandRequest {
    readonly command: string;
    readonly timeoutMs: number;
    readonly cwd: string;
    /* The tmux session and window the run is visible in. Always named, even where there is no tmux wrapper
     * (local dev) and the runner degrades to an invisible shell, whether a browser can be sent to WATCH it is
     * the caller's question to answer from `terminalRun.visible`, because only the caller has somewhere to
     * report a session name to. */
    readonly session: string;
    readonly window: string;
    // How much of the tail is kept for whoever quotes it.
    readonly outputBytes: number;
    // The caller's own cancel. Distinct from the ceiling below: this one means a person asked it to stop.
    readonly signal?: AbortSignal | undefined;
    /* Called when the command is actually in its terminal rather than queued behind another, what a caller
     * with somewhere to report the session name waits for before reporting it (terminal-run.ts). */
    readonly onStarted?: (() => void) | undefined;
}

export const runRuleCommand = async (deps: RuleCommandDeps, request: RuleCommandRequest): Promise<RuleCommandRun> => {
    const { logger, terminalRun } = deps;
    const { command, timeoutMs, cwd, session, window, outputBytes, signal, onStarted } = request;
    const abort = new AbortController();
    let timedOut = false;
    // Counted from the start of the command, a ceiling measured from anywhere else is not the ceiling the rule
    // promises. Unref'd: a rule's watchdog must never be the thing keeping a daemon alive.
    const watchdog = setTimeout(() => {
        timedOut = true;
        logger.warn({ command, timeoutMs }, "rule: command timed out, killing");
        abort.abort();
    }, timeoutMs);
    watchdog.unref();
    const relay = (): void => abort.abort();
    signal?.addEventListener("abort", relay, { once: true });
    const tail = (text: string): string => plainText(text).slice(-outputBytes);
    try {
        const { code, output } = await terminalRun.tryRun(session, command, {
            cwd,
            window,
            signal: abort.signal,
            ...(onStarted !== undefined ? { onStarted } : {}),
        });
        return { status: code === 0 ? "passed" : "failed", exitCode: code, output: tail(output) };
    } catch (cause) {
        // Not our abort ⇒ the command never ran at all. `error`, not `failed`: nothing was learned about the
        // work, so nobody should be sent to fix it.
        if (!abort.signal.aborted) {
            return { status: "error", output: tail(`${command}: ${cause instanceof Error ? cause.message : String(cause)}`) };
        }
        // A kill the watchdog caused is a TIMEOUT, not a cancellation, nobody asked for it, and reporting it as
        // cancelled would hide the one outcome a check most needs to be loud about. The output stays with the
        // pane: what the wrapper had buffered when it was signalled is not a verdict.
        if (timedOut) {
            return { status: "failed", timedOut: true, output: "" };
        }
        return { status: signal?.aborted === true ? "cancelled" : "error", output: "" };
    } finally {
        clearTimeout(watchdog);
        signal?.removeEventListener("abort", relay);
    }
};
