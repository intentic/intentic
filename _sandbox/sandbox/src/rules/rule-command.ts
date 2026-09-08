import { errorMessage } from "@intentic/base/errors";
import type { Services } from "../composition.js";
import { plainText } from "@intentic/base/plain-text";

// Engine under every `command` action, lifted out of the pre-push check so turn.ending gets the same guarantees: a real
// tmux terminal, a ceiling that times out to `failed` rather than silence, a kill that tags itself timeout or cancel
// while the difference is visible, and a plain-text tail with escape codes resolved before the cap.

// `passed`/`failed` are verdicts about the work; `error` means the command never ran, so nobody should be sent to fix
// anything.
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
    // Tmux session/window for the run; watchability is the caller's call (terminalRun.visible).
    readonly session: string;
    readonly window: string;
    // Bytes of trailing output kept for whoever quotes the result.
    readonly outputBytes: number;
    // The caller's own cancel, distinct from the timeout ceiling below.
    readonly signal?: AbortSignal | undefined;
    // Fires once the command is actually running (not queued behind another) in its terminal.
    readonly onStarted?: (() => void) | undefined;
}

export const runRuleCommand = async (deps: RuleCommandDeps, request: RuleCommandRequest): Promise<RuleCommandRun> => {
    const { logger, terminalRun } = deps;
    // Already aborted fires no `abort` event; checked before destructuring so a listener isn't attached too late.
    if (request.signal?.aborted === true) {
        return { status: "cancelled", output: "" };
    }
    const { command, timeoutMs, cwd, session, window, outputBytes, signal, onStarted } = request;
    const abort = new AbortController();
    let timedOut = false;
    // Measured from the command's start; unref'd so a rule's watchdog never keeps the daemon alive alone.
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
        // Not our abort: the command never ran, so `error`, not `failed`; nothing was learned to send someone to fix.
        if (!abort.signal.aborted) {
            return { status: "error", output: tail(`${command}: ${errorMessage(cause)}`) };
        }
        // A watchdog kill is a timeout, not a cancellation; buffered pane output is not a verdict, so it's dropped.
        if (timedOut) {
            return { status: "failed", timedOut: true, output: "" };
        }
        return { status: signal?.aborted === true ? "cancelled" : "error", output: "" };
    } finally {
        clearTimeout(watchdog);
        signal?.removeEventListener("abort", relay);
    }
};
