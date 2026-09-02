import type { PushRun } from "@intentic/sandbox-contract";
import { shellQuote } from "@intentic/sandbox-run/quote";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import type { Services } from "../composition.js";
import { pushRefused } from "../push/notifications.js";
import { type RuleCommandRun, runRuleCommand } from "../rules/rule-command.js";
import { CHECKS_SESSION } from "../terminal/terminal-session.js";
import { pushRefusal, pushRefusalReason } from "./git.js";
import { pushPlan } from "./remote.js";

/* THE OWNER'S PUSH, run the way the pre-push check is run (prepush/prepush.ts), and for the same reason.
 *
 * A push runs the repository's own pre-push hook. In a workspace with a real gate that hook IS the suite, and
 * the push used to run it inside the HTTP request that asked for it: four minutes with the hook's output going
 * nowhere a person could see it, against a browser that gives up on a request's headers after forty-five
 * seconds. The browser then reported "your sandbox didn't answer" over a push that had gone, and the one thing
 * the owner needed, what the hook said, existed only in the daemon's memory as an error's stderr.
 *
 * So the push is a RUN: started and answered at once, executed in the `job-checks` terminal beside the check
 * (one place to read what stood between you and the remote), polled for its verdict, and settled with the
 * plain-text tail of what git and the hook printed, plus the two readings the browser needs to decide what to
 * offer: git's last verdict line, and who refused it (git.ts pushRefusal), because a hook's refusal is the
 * code being wrong and an agent's to fix, and a rejected ref or a dead host is not.
 *
 * PER REPOSITORY, ONE AT A TIME. State is kept per repo (a workspace pushes several), and the runs are
 * serialised through one chain rather than allowed to race for the same terminal window; a second start for a
 * repo already going joins it, two clicks must never mean two pushes. What the pre-push check does before
 * spawning (the memory gate) is not repeated here: the check has already run this suite once, and the hook
 * behind it answers from a cached verdict in milliseconds unless the tree moved.
 *
 * NOTHING IS PERSISTED AND NOTHING IS POLLED AT REST, exactly as for the check: a run exists while it runs,
 * reports to the surface that started it, and is gone with the process. */

// A push's ceiling. Generous, because the hook may be a whole suite; a suite the check just ran answers from
// its cached verdict in milliseconds, and a push that is genuinely still going at fifteen minutes is a hang.
const PUSH_TIMEOUT_MS = 15 * 60_000;
// The tail kept for the fix proposal and the card, the check's budget (prepush.ts), so a quoted refusal is
// the same size whichever half of the push flow it came from.
const PUSH_OUTPUT_BYTES = 24_000;

// What this reaches for out of the daemon. Stated rather than taking Services whole, so a test stands up a
// handful of seams instead of a hundred and thirty.
export type PushRunDeps = Pick<Services, "logger" | "terminalRun" | "pushSender" | "activity">;

export interface PushRuns {
    /* Start the push. Resolves once the run is VISIBLE TO `state`, not when the push finishes, for the reason
     * the check's `run` does: the caller polls `state` the instant this returns, and a start that resolved
     * before the run was published handed that first poll an `idle` the browser reads as "already settled".
     * Idempotent while one is going for the repo. */
    readonly start: (repo: string, dir: string, options: { readonly branch?: string }) => Promise<void>;
    // The run as it stands, what the browser polls: the terminal's name while it goes, the verdict when it settles.
    readonly state: (repo: string) => PushRun;
    // Stop it. A push git had not finished sending does not reach the remote; the run settles as cancelled.
    readonly cancel: (repo: string) => void;
}

const idle = (repo: string): PushRun => ({ status: "idle", repo, command: "", output: "" });

// The line the pane shows and the card names, in the words the owner would type. Not git's global flags: they
// are for the daemon's own status and index reads, and would only make the command harder to read back.
const commandLine = (args: readonly string[]): string => ["git", ...args].map(shellQuote).join(" ");

// The ceiling is injectable for one reader, the test that proves a hung push settles as timed out rather than
// as a run nobody can end; the daemon never names it.
export const createPushRuns = (
    services: PushRunDeps,
    onPushed: (repo: string) => void,
    git: GitRunner = defaultGit,
    ceiling: { readonly timeoutMs?: number } = {},
): PushRuns => {
    const { logger, terminalRun } = services;
    const timeoutMs = ceiling.timeoutMs ?? PUSH_TIMEOUT_MS;
    const runs = new Map<string, PushRun>();
    const controllers = new Map<string, AbortController>();
    const inFlight = new Set<string>();
    // The one terminal window the pushes take turns in. Serialised rather than concurrent for the same reason
    // the check is one at a time: two commands fighting over a pane are unreadable, and two pushes at once buy
    // nothing, a remote round-trip is not where the time goes.
    let queue: Promise<unknown> = Promise.resolve();

    const publish = (run: PushRun): void => {
        runs.set(run.repo, run);
    };

    // The two readings a refused push settles with, and only a refusal: a push that was killed has no last
    // word from git to read, and a push that went has nothing to explain.
    const refusal = (run: RuleCommandRun): Pick<PushRun, "reason" | "refusedBy"> =>
        run.status === "failed" && run.timedOut !== true
            ? { reason: pushRefusalReason(run.output, "git refused the push"), refusedBy: pushRefusal(run.output, run.exitCode) }
            : {};

    // The row in the feed that answers "why isn't my work on the remote", the same row a rule that blocked the
    // push earns (prepush.ts). A pass says nothing.
    const feedLine = (settled: PushRun): string =>
        settled.timedOut === true
            ? `\`${settled.command}\` in ${settled.repo} hit its time limit and was killed, the push did not go.`
            : `\`${settled.command}\` in ${settled.repo} was refused${settled.refusedBy === undefined ? "" : ` by the ${settled.refusedBy}`}: ${settled.reason ?? "it could not run"}.`;

    // What a settled run means to everyone but the poller: the scan, the owner's devices, the feed. One path
    // for a push that ran and one that could not start, so "the owner hears when their push is not going"
    // does not depend on how far it got.
    const report = (settled: PushRun): PushRun => {
        publish(settled);
        logger.info(
            { repo: settled.repo, command: settled.command, status: settled.status, exitCode: settled.exitCode, refusedBy: settled.refusedBy, durationMs: Date.now() - (settled.startedAt ?? Date.now()) },
            "push: settled",
        );
        if (settled.status === "passed") {
            // A push changes nothing locally except ahead/behind, which rides the Changes response: the scan is
            // invalidated so the next read says so.
            onPushed(settled.repo);
        }
        // A verdict the owner is not there to read: the whole point of a push that runs while they get on with
        // something else is that they need not sit over it, so the one outcome that needs them back travels to
        // where they are. A cancel sends nothing, the hand on the Stop button was theirs.
        if (settled.status === "failed" || settled.status === "error") {
            void services.pushSender.notifyIfAway(pushRefused(settled));
            void services.activity
                .append({ direction: "system", type: "git.push_refused", content: feedLine(settled), outcome: "error" })
                .catch((error: unknown) => logger.warn({ err: error, repo: settled.repo }, "push: activity append failed"));
        }
        return settled;
    };

    const settle = (running: PushRun, run: RuleCommandRun): PushRun =>
        report({
            ...running,
            status: run.status,
            ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}),
            ...(run.timedOut !== undefined ? { timedOut: run.timedOut } : {}),
            finishedAt: Date.now(),
            output: run.output,
            ...refusal(run),
        });

    const execute = async (running: PushRun, dir: string, abort: AbortController): Promise<void> => {
        // The terminal only exists where the image's tmux wrapper does; without it the runner degrades to an
        // invisible shell, and a session name nothing can attach to would send the browser after a tab that is
        // never going to be listed. Named only once the command is IN it, as the check does (prepush.ts): the
        // browser opens the panel the moment it reads the name, and a name published while the push was still
        // queued behind another opened it onto nothing.
        const session = terminalRun.visible ? CHECKS_SESSION : undefined;
        logger.info({ repo: running.repo, command: running.command, session }, "push: started");
        const run = await runRuleCommand(services, {
            command: running.command,
            timeoutMs,
            cwd: dir,
            session: CHECKS_SESSION,
            window: "push",
            outputBytes: PUSH_OUTPUT_BYTES,
            signal: abort.signal,
            onStarted: () => {
                if (session !== undefined) {
                    publish({ ...running, session });
                }
            },
        });
        // Republished from what was last published, not from `running`: the session name landed in between.
        settle(runs.get(running.repo) ?? running, run);
    };

    return {
        start: async (repo, dir, options) => {
            if (inFlight.has(repo)) {
                return;
            }
            inFlight.add(repo);
            try {
                const plan = await pushPlan(dir, options, git);
                if (!plan.ok) {
                    // Nothing ran, so this is `error` in the run's own vocabulary: the command could not be run at
                    // all, and there is nothing to send an agent after. The reason is git's situation, not its
                    // words, since git was never asked.
                    const now = Date.now();
                    report({ status: "error", repo, command: "git push", startedAt: now, finishedAt: now, output: "", reason: plan.reason });
                    inFlight.delete(repo);
                    return;
                }
                const running: PushRun = { status: "running", repo, command: commandLine(plan.args), startedAt: Date.now(), output: "" };
                const abort = new AbortController();
                controllers.set(repo, abort);
                publish(running);
                // NOT awaited: the caller is about to poll for the state published above. The queue takes the
                // run when the window frees, and the in-flight mark comes off with the settle, whichever way
                // it settles.
                queue = queue
                    .then(() => execute(running, dir, abort))
                    .catch((error: unknown) => {
                        logger.warn({ err: error, repo }, "push: run failed");
                        publish({ ...running, status: "error", finishedAt: Date.now(), output: "" });
                    })
                    .finally(() => {
                        controllers.delete(repo);
                        inFlight.delete(repo);
                    });
            } catch (error) {
                inFlight.delete(repo);
                throw error;
            }
        },
        state: (repo) => runs.get(repo) ?? idle(repo),
        cancel: (repo) => {
            controllers.get(repo)?.abort();
        },
    };
};
