import type { SubagentSession } from "@intentic/sandbox-contract";
import type { PendingChildCard } from "./children.js";
import { whenFileAppears } from "../tools/file-appears.js";
import { type BackgroundJob, backgroundJobOf, jobFinished, type JobReport, jobReport, jobStatusPath, runningJobsOf } from "../tools/jobs/background-jobs.js";
import { type SubagentWaitOptions, type SubagentWaitUntil, waitForSubagent } from "./subagents.js";
import type { ConversationActors } from "../../conversations/actor/conversation-actors.js";
import { whenSteered } from "../../conversations/actor/conversation-holdings.js";
import { opt } from "../../opt.js";

// The one park for work a conversation started here: a child agent, or a background command.

export interface WorkWaitOutcome {
    // `message`: words were said into the waiting turn (a person, a watch, a child's report, the sandbox), which its
    // runtime reads only once this tool call returns.
    readonly outcome: SubagentWaitUntil | "timeout" | "aborted" | "unknown-target" | "message";
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

// How long a wait lets words said into its turn travel to the runtime before it hands the turn back, so they arrive with
// its answer rather than after the next tool call.
const HEARD_GRACE_MS = 1_500;

// Settles `message` once words are said into the waiting conversation's live turn; never, until then. The signal ends the
// listening with the wait.
const wordsSaid = (actors: Actors, conversationId: string, signal: AbortSignal): Promise<WorkWaitOutcome> =>
    new Promise((resolve) => {
        let grace: ReturnType<typeof setTimeout> | undefined;
        const stop = whenSteered(actors, conversationId, () => {
            if (grace !== undefined) {
                return;
            }
            grace = setTimeout(() => resolve({ outcome: "message" }), HEARD_GRACE_MS);
            grace.unref();
        });
        signal.addEventListener(
            "abort",
            () => {
                stop();
                clearTimeout(grace);
            },
            { once: true },
        );
    });

/**
 * Parks until the named child or command (by the id its Bash call returned) moves, or for "any" whichever moves first;
 * words said into the waiting turn meanwhile hand it back at once, with outcome `message`.
 */
export const waitForWork = async (actors: Actors, conversationId: string, options: SubagentWaitOptions): Promise<WorkWaitOutcome> => {
    if (options.signal?.aborted === true) {
        return { outcome: "aborted" };
    }
    const heard = new AbortController();
    const abort = (): void => heard.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
        return await Promise.race([parkOnWork(actors, conversationId, { ...options, signal: heard.signal }), wordsSaid(actors, conversationId, heard.signal)]);
    } finally {
        options.signal?.removeEventListener("abort", abort);
        heard.abort();
    }
};

// The park itself: the named command, else the children, raced against every command still running for "any".
const parkOnWork = async (actors: Actors, conversationId: string, options: SubagentWaitOptions): Promise<WorkWaitOutcome> => {
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

// What a wait handed back for words said into its turn tells the model, since the words themselves come after it.
const WORDS_SAID =
    "Something was said into your turn while you waited (the owner, a watch that fired, a child's report or the sandbox): it follows this result. Read it, then wait again if you still need to; nothing you were waiting on has moved.";

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
        ...opt("note", result.outcome === "message" ? WORDS_SAID : undefined),
    };
};
