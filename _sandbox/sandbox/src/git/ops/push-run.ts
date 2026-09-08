import type { PushRun } from "@intentic/sandbox-contract";
import { shellQuote } from "@intentic/sandbox-run/quote";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import type { Services } from "../../composition.js";
import { pushRefused } from "../../push/notifications.js";
import { type RuleCommandRun, runRuleCommand } from "../../rules/rule-command.js";
import { CHECKS_SESSION } from "../../terminal/terminal-session.js";
import { pushRefusal, pushRefusalReason } from "../git.js";
import { pushPlan } from "../remote/remote.js";

// Runs a push the way the pre-push check runs (prepush/prepush.ts): started and answered at once, executed in the
// `job-checks` terminal, polled for its verdict. Serialized per repo (a second start for a running repo just joins it);
// nothing is persisted or polled at rest — a run exists only while it runs.

// Generous ceiling since the hook may be a whole suite (usually cached, fast); past this it's a hang.
const PUSH_TIMEOUT_MS = 15 * 60_000;
// Same output budget as the check (prepush.ts), so a quoted refusal is the same size either way.
const PUSH_OUTPUT_BYTES = 24_000;

// What this needs from the daemon, stated explicitly so a test stands up a handful of seams, not all of Services.
export type PushRunDeps = Pick<Services, "logger" | "terminalRun" | "pushSender" | "activity">;

export interface PushRuns {
    // Resolves once the run is visible to `state`, not when it finishes: resolving early would hand the first poll an
    // `idle` read as already settled. Idempotent while one is running for the repo.
    readonly start: (repo: string, dir: string, options: { readonly branch?: string }) => Promise<void>;
    // The run as it stands: the terminal's name while going, the verdict once it settles.
    readonly state: (repo: string) => PushRun;
    // Stop it. A push git had not finished sending does not reach the remote; the run settles as cancelled.
    readonly cancel: (repo: string) => void;
}

const idle = (repo: string): PushRun => ({ status: "idle", repo, command: "", output: "" });

// The line shown in the pane and named on the card, without git's own global flags (those are for status/index reads,
// not readability here).
const commandLine = (args: readonly string[]): string => ["git", ...args].map(shellQuote).join(" ");

// `ceiling` is injectable only for the test proving a hung push times out rather than running forever; the daemon never
// overrides it.
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
    // One terminal, pushes take turns: two commands sharing a pane is unreadable, and concurrency buys nothing here.
    let queue: Promise<unknown> = Promise.resolve();

    const publish = (run: PushRun): void => {
        runs.set(run.repo, run);
    };

    // Reason and refusedBy, only for an actual refusal: a killed push has no last word from git, and a passed one has
    // nothing to explain.
    const refusal = (run: RuleCommandRun): Pick<PushRun, "reason" | "refusedBy"> =>
        run.status === "failed" && run.timedOut !== true
            ? { reason: pushRefusalReason(run.output, "git refused the push"), refusedBy: pushRefusal(run.output, run.exitCode) }
            : {};

    // Feed row answering "why isn't my work on the remote", same as a blocking rule earns (prepush.ts); a pass says
    // nothing.
    const feedLine = (settled: PushRun): string =>
        settled.timedOut === true
            ? `\`${settled.command}\` in ${settled.repo} hit its time limit and was killed, the push did not go.`
            : `\`${settled.command}\` in ${settled.repo} was refused${settled.refusedBy === undefined ? "" : ` by the ${settled.refusedBy}`}: ${settled.reason ?? "it could not run"}.`;

    // What a settled run means to everyone but the poller (scan, devices, feed); one path whether the push ran or never
    // started.
    const report = (settled: PushRun): PushRun => {
        publish(settled);
        logger.info(
            { repo: settled.repo, command: settled.command, status: settled.status, exitCode: settled.exitCode, refusedBy: settled.refusedBy, durationMs: Date.now() - (settled.startedAt ?? Date.now()) },
            "push: settled",
        );
        if (settled.status === "passed") {
            // A push only moves ahead/behind locally; invalidating the scan is how the Changes response picks it up.
            onPushed(settled.repo);
        }
        // A verdict reached while the owner is away travels to their devices; a cancel sends nothing, since the Stop
        // button was their own hand.
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
        // No session without the tmux wrapper, or the browser would chase a tab nothing lists. Named only once the
        // command is actually in it (as the check does), not while still queued.
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
                    // `error`, not `failed`: nothing ran, so there's no agent-fixable command output, only git's
                    // situation (git was never invoked).
                    const now = Date.now();
                    report({ status: "error", repo, command: "git push", startedAt: now, finishedAt: now, output: "", reason: plan.reason });
                    inFlight.delete(repo);
                    return;
                }
                const running: PushRun = { status: "running", repo, command: commandLine(plan.args), startedAt: Date.now(), output: "" };
                const abort = new AbortController();
                controllers.set(repo, abort);
                publish(running);
                // Not awaited: the caller polls the published state instead. The queue runs it when the window frees;
                // in-flight clears on settle, whichever way it goes.
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
