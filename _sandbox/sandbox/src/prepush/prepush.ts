import type { PrepushRun, Rule } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";
import { waitForMemoryHeadroom } from "../platform/memory-admission.js";
import { prepushFailed } from "../push/notifications.js";
import { type RuleCommandRun, runRuleCommand } from "../rules/rule-command.js";
import { matching } from "../rules/rules.js";
import { CHECKS_SESSION } from "../terminal/terminal-session.js";

/* THE PRE-PUSH CHECK, the workspace's own answer to "would this push go red", asked at the push and answered
 * while the user waits for it.
 *
 * WHY THE PUSH AND NOT THE LAND, which is where this used to run. A post-land verdict is about a tree that keeps
 * moving: the user commits by parts, another agent lands, an edit arrives. So the verdict spent its life either
 * stale or being recomputed, and it needed a content fingerprint, a staleness rule, a persisted store and a badge
 * to say which of those it was, machinery whose entire job was answering "is this still about the tree in front
 * of me". The push asks that question for free. There is exactly one artifact at the push, the user is standing
 * in front of it, and nothing else is going to change underneath before it leaves the machine.
 *
 * SO NOTHING IS PERSISTED AND NOTHING IS POLLED AT REST. A run exists while it runs, reports to the surface that
 * started it, and is gone with the process. Nothing survives a daemon restart because nothing needs to: the next
 * push asks again, and an answer the user is not waiting on has no reader.
 *
 * THE USER IS NOT REQUIRED TO WATCH. They start a push and go and do something else, so a red verdict is pushed
 * to their devices (settle, below) rather than waiting to be discovered, the one outcome that needs them back.
 *
 * IT RUNS IN A REAL TERMINAL, which is the standing rule for every shell command the daemon runs on a user's
 * click (terminal/terminal-run.ts). The suite is a tmux window in the `job-checks` session, so the output the
 * user watches is a terminal's, colour, carriage returns, a runner's progress rewriting its own line, the wheel
 * scrolling back through it, and the app is left holding only the question. What this module keeps of that
 * output is the TAIL, and for one reader only: the fix the app proposes when the suite goes red.
 *
 * WHAT IT RUNS ON. The main working tree, always, that is where the commits about to be pushed live, and it is
 * the tree whose node_modules resolve this monorepo's cross-package imports to the sources that will actually
 * ship (agents/worktrees.ts explains why an isolated worktree cannot answer this).
 */

// How much of the output is kept for the fix turn seeded from a red run. Enough to see the actual failure,
// bounded so the prompt stays about fixing rather than scrolling, the whole run is in the pane (and its log)
// for anyone who wants it. The TAIL, because a suite's verdict and its failure summary are at the end. Counted
// on the CLEANED text (plain-text.ts), so the budget buys failure and not a runner's colour codes.
const PREPUSH_OUTPUT_BYTES = 24_000;

const IDLE: PrepushRun = { status: "idle", command: "", output: "" };

export interface PrepushCheck {
    /* Start the check. Idempotent while one is already going, two clicks must never mean two suites fighting
     * over the same tree, the same ports and the same CPU.
     *
     * IT RESOLVES WHEN THE RUN IS VISIBLE TO `state`, not when the suite finishes. The route awaits it for
     * exactly that reason: the caller polls `state` the moment the POST returns, and a `run` that resolved
     * before the command was under way handed that first poll an `idle` the dialog reads as "already settled",
     * a push dialog that closed itself on a check it never waited for. The suite itself still outlives the
     * request. */
    readonly run: () => Promise<void>;
    // The run as it stands. What the push dialog polls: it needs the terminal's name while the check is going,
    // and the verdict when it settles.
    readonly state: () => Promise<PrepushRun>;
    // Stop the suite: the dialog's Stop checks, and the daemon's own shutdown, a dying daemon must not leave a
    // suite burning CPU with nothing left to report to. One verb for both, because the kill is the same one and
    // the verdict it writes has no reader once the process is going down.
    readonly cancel: () => void;
}

// What this reaches for out of the daemon. Stated rather than taking Services whole, so a test stands up a
// handful of seams instead of a hundred and thirty.
export type PrepushDeps = Pick<Services, "logger" | "sandboxSettings" | "workspace" | "terminalRun" | "pushSender" | "ruleFirings" | "activity">;

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
    // True from the moment `run` is entered until the command is under way, the window `running` cannot cover,
    // because reading the settings is an await (see `run`).
    let starting = false;
    // How a run is stopped: aborting SIGTERMs the wrapper, whose trap kills the tmux window (terminal-run.ts).
    // WHY it stopped, a cancel and a timeout produce the same rejection and mean opposite things to the user,
    // is the command runner's to distinguish and report (rules/rule-command.ts).
    let controller: AbortController | undefined;

    /* EVERY RULE STANDING AT THIS PUSH, IN THE OWNER'S ORDER, STOPPING AT THE FIRST ONE THAT DOES NOT PASS.
     *
     * Two checks before a push are two checks: running only the first would drop the second silently, which is
     * the one thing a gate must never do. Stopping at the first failure is the other half of the same
     * judgement, the push is already not going, and burning ten more minutes of the owner's suite to tell them
     * so again is time spent on an answer they have.
     *
     * `current` is republished before each rule, so a dialog polling it names the command actually running
     * rather than the first of several. */
    const execute = async (rules: readonly Rule[]): Promise<PrepushRun> => {
        const startedAt = Date.now();
        const abort = new AbortController();
        controller = abort;
        // The terminal only exists where the image's tmux wrapper does; without it the runner degrades to an
        // invisible shell, and a session name nothing can attach to would send the browser after a tab that is
        // never going to be listed.
        const session = terminalRun.visible ? CHECKS_SESSION : undefined;
        /* THE SESSION IS ONLY NAMED ONCE THE COMMAND IS IN IT. `session` on a running state is not a label,
         * it is the app's instruction to go and open that terminal, and it acts on it the moment it reads it.
         * Published up front, it named a tab that did not exist yet: the suite could still be queued behind
         * another check in the same session, and the panel opened onto a name tmux had not created, showing a
         * spinner over an empty panel while the run it was waiting for happened somewhere it never looked. So
         * this stays undefined until the runner says the command has left the queue and its window is being
         * made, which is also the honest answer to "where is my check running" before that. */
        let opened: string | undefined;
        const settle = (rule: Rule, command: string, run: RuleCommandRun): PrepushRun => {
            const settled: PrepushRun = {
                status: run.status,
                ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}),
                ...(run.timedOut !== undefined ? { timedOut: run.timedOut } : {}),
                command,
                startedAt,
                finishedAt: Date.now(),
                ...(opened !== undefined ? { session: opened } : {}),
                output: run.output,
            };
            current = settled;
            logger.info(
                { rule: rule.id, command, status: settled.status, exitCode: settled.exitCode, durationMs: Date.now() - startedAt },
                "prepush: check settled",
            );
            /* A verdict the user is not there to read. The whole point of a check that runs while they get on
             * with something else is that they do not have to sit over it, so the one outcome that needs them
             * back has to travel to where they are. `notifyIfAway` decides whether they are actually away; a
             * pass sends nothing (the push just goes) and a cancel sends nothing (they stopped it themselves). */
            if (settled.status === "failed" || settled.status === "error") {
                void services.pushSender.notifyIfAway(prepushFailed(settled));
            }
            return settled;
        };
        try {
            let last: PrepushRun = IDLE;
            for (const rule of rules) {
                if (rule.action.kind !== "command") {
                    continue;
                }
                const { command, timeoutMs } = rule.action;
                opened = undefined;
                current = { status: "running", command, startedAt, output: "" };
                /* THE MEMORY GATE, before the spawn and after `current` is published (so the dialog already
                 * shows the check underway while it queues). A whole-monorepo suite is the biggest thing this
                 * daemon ever starts of its own accord, and starting one onto a box that is already pinned is
                 * how the 2026-08-25 freeze happened. The wait is bounded and then the suite runs regardless —
                 * see waitForMemoryHeadroom for why neither refusing nor barging in is right here. */
                const headroom = await waitForMemoryHeadroom({ signal: abort.signal });
                if (headroom.waitedMs > 0) {
                    logger.info({ rule: rule.id, waitedMs: headroom.waitedMs, admitted: headroom.admitted }, "prepush: waited for memory headroom");
                }
                if (!headroom.admitted) {
                    logger.warn({ rule: rule.id, message: headroom.message }, "prepush: starting without memory headroom");
                }
                logger.info({ rule: rule.id, command, session }, "prepush: check started");
                // `window` names the tmux window rather than the command, so a session holding several runs
                // reads as a list of checks.
                const run = await runRuleCommand(services, {
                    command,
                    timeoutMs,
                    cwd: workspace.root,
                    session: CHECKS_SESSION,
                    window: "checks",
                    outputBytes: PREPUSH_OUTPUT_BYTES,
                    signal: abort.signal,
                    onStarted: () => {
                        opened = session;
                        // Republished rather than mutated: the dialog polls whole states, and this is the one
                        // that carries "there is a terminal now, go and open it".
                        current = { ...current, ...(session !== undefined ? { session } : {}) };
                    },
                });
                last = settle(rule, command, run);
                // A check that ran did something, whichever way it went, that is what the settings list's
                // "last fired" is answering, and a rule only ever stamped on failure would read as never used
                // in exactly the workspace where it is working.
                void services.ruleFirings
                    .stamp(rule.id, Date.now())
                    .catch((error: unknown) => logger.warn({ err: error, rule: rule.id }, "prepush: firing stamp failed"));
                if (run.status !== "passed") {
                    // The one outcome worth a row in the feed: a push the owner asked for did not go, and the
                    // named rule is the answer to the "why won't my push go" they are about to ask. A pass says
                    // nothing, a feed that logs every green check is one the eye learns to skip.
                    if (run.status !== "cancelled") {
                        void services.activity
                            .append({
                                direction: "system",
                                type: "rule.blocked_push",
                                content: `"${rule.label}" ran \`${command}\` before your push and it ${run.timedOut === true ? "timed out" : `exited ${run.exitCode ?? "abnormally"}`}, the push did not go.`,
                                outcome: "error",
                            })
                            .catch((error: unknown) => logger.warn({ err: error, rule: rule.id }, "prepush: activity append failed"));
                    }
                    return last;
                }
            }
            return last;
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
                const rules = matching((await services.sandboxSettings.get()).rules, "push.starting");
                // Nothing standing here ⇒ nothing to run and nothing to say. The dialog never opens without a
                // rule, so this is the race where the last one was deleted between the click and the request.
                if (rules.length === 0) {
                    current = IDLE;
                    return;
                }
                // NOT awaited: `execute` runs synchronously as far as publishing the `running` state this
                // function's caller is about to poll for, and only then awaits the suite.
                running = execute(rules).finally(() => {
                    running = undefined;
                });
                running.catch((error: unknown) => logger.warn({ err: error }, "prepush: check failed"));
            } finally {
                starting = false;
            }
        },
        state: async () => {
            // No rule ⇒ the check is off, whatever the last run concluded. A result from before the rule was
            // deleted would otherwise gate a push on a check nobody can run any more.
            if (matching((await services.sandboxSettings.get()).rules, "push.starting").length === 0) {
                return IDLE;
            }
            return current;
        },
        cancel: () => {
            controller?.abort();
        },
    };
};
