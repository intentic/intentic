import type { SubagentSession } from "@intentic/sandbox-contract";
import type { PendingChildCard } from "./children.js";
import { whenFileAppears } from "../tools/file-appears.js";
import { type BackgroundJob, backgroundJobOf, jobFinished, type JobReport, jobReport, jobStatusPath, runningJobsOf } from "../tools/jobs/background-jobs.js";
import { type SubagentWaitOptions, type SubagentWaitUntil, waitForSubagent } from "./subagents.js";
import type { ConversationActors } from "../../conversations/actor/conversation-actors.js";

// The one park for work a conversation started here: a child agent, or a background command.

export interface WorkWaitOutcome {
    readonly outcome: SubagentWaitUntil | "timeout" | "aborted" | "unknown-target";
    // The child that moved, or the target's snapshot on a timeout.
    readonly agent?: SubagentSession;
    // The command that finished, or the target's snapshot on a timeout.
    readonly job?: JobReport;
}

// A job's completion is bin/tmux-run's status file appearing; polled at this cadence, in ms, only where unwatchable.
const JOB_POLL_MS = 500;

// The first of these jobs to finish, or the timeout, or the abort.
// Where a conversation's children and commands are held: each conversation's actor.
type Actors = Pick<ConversationActors, "holdings">;

const waitForJobs = (
    actors: Actors,
    jobs: readonly BackgroundJob[],
    options: Pick<SubagentWaitOptions, "timeoutMs" | "signal">,
): Promise<WorkWaitOutcome> =>
    new Promise((resolve) => {
        if (options.signal?.aborted === true) {
            resolve({ outcome: "aborted" });
            return;
        }
        const stops: (() => void)[] = [];
        let poll: ReturnType<typeof setInterval> | undefined;
        let settled = false;
        const settle = (outcome: Promise<WorkWaitOutcome>): void => {
            if (settled) {
                return;
            }
            settled = true;
            for (const stop of stops.splice(0)) {
                stop();
            }
            clearInterval(poll);
            clearTimeout(deadline);
            options.signal?.removeEventListener("abort", onAbort);
            resolve(outcome);
        };
        const onAbort = (): void => settle(Promise.resolve({ outcome: "aborted" }));
        const look = (): void => {
            const done = jobs.find(jobFinished);
            if (done !== undefined) {
                settle(jobReport(actors, done).then((job) => ({ outcome: "finished", job })));
            }
        };
        const deadline = setTimeout(
            () => {
                look();
                const only = jobs.length === 1 ? jobs[0] : undefined;
                settle(
                    only === undefined
                        ? Promise.resolve({ outcome: "timeout" })
                        : jobReport(actors, only).then((job) => ({ outcome: "timeout", job })),
                );
            },
            Math.max(0, options.timeoutMs),
        );
        deadline.unref();
        options.signal?.addEventListener("abort", onAbort, { once: true });
        for (const job of jobs) {
            const stop = whenFileAppears(jobStatusPath(job), look);
            if (settled) {
                stop?.();
                return;
            }
            if (stop === undefined) {
                poll ??= setInterval(look, JOB_POLL_MS);
                poll.unref();
            } else {
                stops.push(stop);
            }
        }
    });

const fromSubagent = async (actors: Actors, conversationId: string, options: SubagentWaitOptions): Promise<WorkWaitOutcome> => {
    const result = await waitForSubagent(actors, conversationId, options);
    return { outcome: result.outcome, ...(result.matched === undefined ? {} : { agent: result.matched }) };
};

// Never settles: a race partner with nothing to wait for leaves the answer to the other.
const NEVER = new Promise<WorkWaitOutcome>(() => {});

/** Parks until the named child or command (by the id its Bash call returned) moves, or for "any" whichever moves first. */
export const waitForWork = async (actors: Actors, conversationId: string, options: SubagentWaitOptions): Promise<WorkWaitOutcome> => {
    // A command only ever finishes, so it answers a named wait whatever `until` asks for.
    const named = options.target === undefined ? undefined : backgroundJobOf(actors, conversationId, options.target);
    if (named !== undefined) {
        return waitForJobs(actors, [named], options);
    }
    const jobs = options.target === undefined && options.until.includes("finished") ? runningJobsOf(actors, conversationId) : [];
    if (jobs.length === 0) {
        return fromSubagent(actors, conversationId, options);
    }
    const race = new AbortController();
    const abort = (): void => race.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
        const children = fromSubagent(actors, conversationId, { ...options, signal: race.signal }).then((result) =>
            // No child to wait on is not a move.
            result.outcome === "unknown-target" ? NEVER : result,
        );
        return await Promise.race([children, waitForJobs(actors, jobs, { timeoutMs: options.timeoutMs, signal: race.signal })]);
    } finally {
        options.signal?.removeEventListener("abort", abort);
        race.abort();
    }
};

/** The answer every wait door gives, a blocked child's whole question included so the caller can answer it. */
export const workWaitAnswer = (
    result: WorkWaitOutcome,
    pendingQuestion: (childId: string) => PendingChildCard | undefined,
): Record<string, unknown> => {
    const question = result.outcome === "blocked" && result.agent !== undefined ? pendingQuestion(result.agent.id) : undefined;
    return {
        outcome: result.outcome,
        ...(result.agent === undefined ? {} : { agent: result.agent }),
        ...(result.job === undefined ? {} : { job: result.job }),
        ...(question === undefined ? {} : { question }),
    };
};
