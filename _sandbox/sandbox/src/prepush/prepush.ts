import type { PrepushRun } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";
import { prepushFailed } from "../push/notifications.js";
import { plainText } from "../terminal/plain-text.js";
import { PREPUSH_SESSION } from "../terminal/terminal-session.js";

/* THE PRE-PUSH CHECK — the workspace's own answer to "would this push go red", asked at the push and answered
 * while the user waits for it.
 *
 * WHY THE PUSH AND NOT THE LAND, which is where this used to run. A post-land verdict is about a tree that keeps
 * moving: the user commits by parts, another agent lands, an edit arrives. So the verdict spent its life either
 * stale or being recomputed, and it needed a content fingerprint, a staleness rule, a persisted store and a badge
 * to say which of those it was — machinery whose entire job was answering "is this still about the tree in front
 * of me". The push asks that question for free. There is exactly one artifact at the push, the user is standing
 * in front of it, and nothing else is going to change underneath before it leaves the machine.
 *
 * SO NOTHING IS PERSISTED AND NOTHING IS POLLED AT REST. A run exists while it runs, reports to the surface that
 * started it, and is gone with the process. Nothing survives a daemon restart because nothing needs to: the next
 * push asks again, and an answer the user is not waiting on has no reader.
 *
 * THE USER IS NOT REQUIRED TO WATCH. They start a push and go and do something else, so a red verdict is pushed
 * to their devices (settle, below) rather than waiting to be discovered — the one outcome that needs them back.
 *
 * IT RUNS IN A REAL TERMINAL, which is the standing rule for every shell command the daemon runs on a user's
 * click (terminal/terminal-run.ts). The suite is a tmux window in the `job-checks` session, so the output the
 * user watches is a terminal's — colour, carriage returns, a runner's progress rewriting its own line, the wheel
 * scrolling back through it — and the app is left holding only the question. What this module keeps of that
 * output is the TAIL, and for one reader only: the fix the app proposes when the suite goes red.
 *
 * WHAT IT RUNS ON. The main working tree, always — that is where the commits about to be pushed live, and it is
 * the tree whose node_modules resolve this monorepo's cross-package imports to the sources that will actually
 * ship (agents/worktrees.ts explains why an isolated worktree cannot answer this).
 */

// How much of the output is kept for the fix turn seeded from a red run. Enough to see the actual failure,
// bounded so the prompt stays about fixing rather than scrolling — the whole run is in the pane (and its log)
// for anyone who wants it. The TAIL, because a suite's verdict and its failure summary are at the end. Counted
// on the CLEANED text (plain-text.ts), so the budget buys failure and not a runner's colour codes.
const PREPUSH_OUTPUT_BYTES = 24_000;

const IDLE: PrepushRun = { status: "idle", command: "", output: "" };

export interface PrepushCheck {
    /* Start the check. Idempotent while one is already going — two clicks must never mean two suites fighting
     * over the same tree, the same ports and the same CPU.
     *
     * IT RESOLVES WHEN THE RUN IS VISIBLE TO `state`, not when the suite finishes. The route awaits it for
     * exactly that reason: the caller polls `state` the moment the POST returns, and a `run` that resolved
     * before the command was under way handed that first poll an `idle` the dialog reads as "already settled" —
     * a push dialog that closed itself on a check it never waited for. The suite itself still outlives the
     * request. */
    readonly run: () => Promise<void>;
    // The run as it stands. What the push dialog polls: it needs the terminal's name while the check is going,
    // and the verdict when it settles.
    readonly state: () => Promise<PrepushRun>;
    // Stop the suite: the dialog's Stop checks, and the daemon's own shutdown — a dying daemon must not leave a
    // suite burning CPU with nothing left to report to. One verb for both, because the kill is the same one and
    // the verdict it writes has no reader once the process is going down.
    readonly cancel: () => void;
}

// What this reaches for out of the daemon. Stated rather than taking Services whole, so a test stands up five
// seams instead of a hundred and thirty.
export type PrepushDeps = Pick<Services, "logger" | "sandboxSettings" | "workspace" | "terminalRun" | "pushSender">;

/* THE ONE CHECK THIS PROCESS HAS. A module singleton because the routes (the dialog's clicks) and the shutdown
 * hook all have to reach the SAME live run, and there is only one main working tree for them to be about.
 * Tests build their own with createPrepushCheck instead, which is why that stays exported. */
let instance: PrepushCheck | undefined;
export const prepushCheck = (services: PrepushDeps): PrepushCheck => (instance ??= createPrepushCheck(services));

export const createPrepushCheck = (services: PrepushDeps): PrepushCheck => {
    const { logger, terminalRun, workspace } = services;
    let current: PrepushRun = IDLE;
    // The promise every concurrent caller joins instead of starting a second suite.
    let running: Promise<PrepushRun> | undefined;
    // True from the moment `run` is entered until the command is under way — the window `running` cannot cover,
    // because reading the settings is an await (see `run`).
    let starting = false;
    /* How a run is stopped: aborting SIGTERMs the wrapper, whose trap kills the tmux window (terminal-run.ts).
     * The two flags say WHY it stopped, because the abort itself cannot — a cancel and a timeout produce the
     * same rejection and mean opposite things to the user. Both are reset by the next `run`. */
    let controller: AbortController | undefined;
    let cancelled = false;
    let timedOut = false;

    const execute = async (command: string, timeoutMs: number): Promise<PrepushRun> => {
        const startedAt = Date.now();
        const abort = new AbortController();
        controller = abort;
        // Counted from the start of the command — a ceiling measured from anywhere else is not the ceiling the
        // setting promises. Unref'd: a check's watchdog must never be the thing keeping a daemon alive.
        const watchdog = setTimeout(() => {
            timedOut = true;
            logger.warn({ command, timeoutMs }, "prepush: check timed out — killing");
            abort.abort();
        }, timeoutMs);
        watchdog.unref();
        // The terminal only exists where the image's tmux wrapper does; without it the runner degrades to an
        // invisible shell, and a session name nothing can attach to would send the browser after a tab that is
        // never going to be listed.
        const session = terminalRun.visible ? PREPUSH_SESSION : undefined;
        logger.info({ command, session }, "prepush: check started");
        current = { status: "running", command, startedAt, output: "", ...(session !== undefined ? { session } : {}) };
        const settle = (fields: Omit<PrepushRun, "command" | "startedAt" | "finishedAt" | "session">): PrepushRun => {
            const settled: PrepushRun = {
                ...fields,
                command,
                startedAt,
                finishedAt: Date.now(),
                ...(session !== undefined ? { session } : {}),
                // The suite ran in a real terminal and printed for one; what it printed is about to be quoted
                // into a prompt a human edits and a model reads, so it arrives as text (plain-text.ts).
                output: plainText(fields.output).slice(-PREPUSH_OUTPUT_BYTES),
            };
            current = settled;
            logger.info(
                { command, status: settled.status, exitCode: settled.exitCode, timedOut, durationMs: Date.now() - startedAt },
                "prepush: check settled",
            );
            /* A verdict the user is not there to read. The whole point of a check that runs while they get on
             * with something else is that they do not have to sit over it — so the one outcome that needs them
             * back has to travel to where they are. `notifyIfAway` decides whether they are actually away; a
             * pass sends nothing (the push just goes) and a cancel sends nothing (they stopped it themselves). */
            if (settled.status === "failed" || settled.status === "error") {
                void services.pushSender.notifyIfAway(prepushFailed(settled));
            }
            return settled;
        };
        try {
            // `window` names the tmux window rather than the command, so a session holding several runs reads as
            // a list of checks. The runner's own timeout is left alone — this module's watchdog owns the ceiling,
            // because it is the only one that can tell the dialog which of the two kills happened.
            const { code, output } = await terminalRun.tryRun(PREPUSH_SESSION, command, {
                cwd: workspace.root,
                window: "checks",
                signal: abort.signal,
            });
            clearTimeout(watchdog);
            return settle({ status: code === 0 ? "passed" : "failed", exitCode: code, output });
        } catch (cause) {
            clearTimeout(watchdog);
            /* Not our abort ⇒ the command never ran at all: no shell, an unreadable cwd, a missing wrapper.
             * `error`, not `failed` — nothing was learned about the code, so nobody should be sent to fix it. */
            if (!abort.signal.aborted) {
                return settle({ status: "error", output: `${command}: ${cause instanceof Error ? cause.message : String(cause)}` });
            }
            // A kill the watchdog caused is a TIMEOUT, not a cancellation — the user asked for neither, and
            // reporting it as cancelled would hide the one outcome this check most needs to be loud about. The
            // output stays with the pane: what the wrapper had buffered when it was signalled is not a verdict.
            if (timedOut) {
                return settle({ status: "failed", timedOut: true, output: "" });
            }
            return settle({ status: cancelled ? "cancelled" : "error", output: "" });
        } finally {
            controller = undefined;
        }
    };

    return {
        run: async () => {
            // `starting` and not just `running`: the settings read below is an await, so two calls in the same
            // tick would both find `running` unset and spawn a suite each. This flag is set before any await,
            // which is the only kind of guard that can hold across one.
            if (running !== undefined || starting) {
                return;
            }
            starting = true;
            try {
                const { prepushCommand, prepushTimeoutMs } = await services.sandboxSettings.get();
                // No command ⇒ nothing to run and nothing to say. The dialog never opens without one, so this is
                // the race where the setting was cleared between the click and the request.
                if (prepushCommand === "") {
                    current = IDLE;
                    return;
                }
                cancelled = false;
                timedOut = false;
                // NOT awaited: `execute` runs synchronously as far as publishing the `running` state this
                // function's caller is about to poll for, and only then awaits the suite.
                running = execute(prepushCommand, prepushTimeoutMs).finally(() => {
                    running = undefined;
                });
                running.catch((error: unknown) => logger.warn({ err: error }, "prepush: check failed"));
            } finally {
                starting = false;
            }
        },
        state: async () => {
            const { prepushCommand } = await services.sandboxSettings.get();
            // No command ⇒ the check is off, whatever the last run concluded. A result from before the setting
            // was cleared would otherwise gate a push on a check nobody can run any more.
            if (prepushCommand === "") {
                return IDLE;
            }
            return current;
        },
        cancel: () => {
            cancelled = true;
            controller?.abort();
        },
    };
};
