import { classifyCommand } from "@intentic/sandbox-contract";
import { shellQuote } from "@intentic/sandbox-run/quote";
import type { Logger } from "pino";
import { armWatcher, type WatcherSpec } from "../verification/watchers.js";
import { type BackgroundJob, jobCommandLine, JOB_MAX_MS, jobOutputPath, jobStatusPath, OUTPUT_TAIL_BYTES, settledBackgroundJobs } from "./background-jobs.js";

// Kept apart from background-jobs.ts, whose importing the watch engine would close a cycle through agent.ts.

// Seconds between completion checks.
const CHECK_INTERVAL_S = 30;

// Exits 0 only once the status file exists, printing the command's exit code and then its output tail.
export const completionCheck = (job: BackgroundJob): string => {
    const status = shellQuote(jobStatusPath(job));
    const output = shellQuote(jobOutputPath(job));
    return `test -f ${status} || exit 1; printf 'exit %s\\n' "$(cat ${status})"; tail -c ${String(OUTPUT_TAIL_BYTES)} ${output} 2>/dev/null; exit 0`;
};

// The headline of the notice row the wake becomes.
export const jobNote = (job: BackgroundJob, finished: boolean): string =>
    finished
        ? `background job that finished after the turn last looked: \`${jobCommandLine(job.command)}\``
        : `background job left running when the turn ended: \`${jobCommandLine(job.command)}\``;

// A fetching job's output is outside content, as a fetching Bash result is.
const outsideOf = (job: BackgroundJob): { readonly outside?: string } =>
    classifyCommand(job.command, { locus: "sandbox" }).includes("network.outbound") ? { outside: "shell-fetch" } : {};

const specOf = (job: BackgroundJob, finished: boolean): WatcherSpec => ({
    conversationId: job.conversationId,
    command: completionCheck(job),
    note: jobNote(job, finished),
    intervalSeconds: CHECK_INTERVAL_S,
    timeoutSeconds: Math.round(JOB_MAX_MS / 1000),
    // Once the tmp sweep takes this dir, a restored watch wakes as broken rather than waiting on nothing.
    cwd: job.dir,
    // The check reads two files and needs no credential.
    env: {},
    ...outsideOf(job),
    turn: job.turn,
});

/** Answers how many jobs it handed to a watch; never throws, since it runs off a turn's ending. */
export const adoptBackgroundJobs = async (conversationId: string, logger: Logger): Promise<number> => {
    const { running, unseen } = settledBackgroundJobs(conversationId);
    let handed = 0;
    for (const [job, finished] of [...running.map((entry) => [entry, false] as const), ...unseen.map((entry) => [entry, true] as const)]) {
        try {
            // A job exiting between the settle and this check still finished after the model's last look.
            const outcome = await armWatcher(specOf(job, finished), { reportIfMet: true });
            if (outcome.kind === "armed" || outcome.kind === "reported") {
                handed += 1;
                logger.info({ conversationId, job: job.id, watch: outcome.id, session: job.session, outcome: outcome.kind }, "background job: handed to a watch, its completion will wake the conversation");
                continue;
            }
            logger.warn({ conversationId, job: job.id, outcome: outcome.kind, dir: job.dir }, "background job: not handed to a watch, its completion will go unreported");
        } catch (error) {
            logger.warn({ err: error, conversationId, job: job.id }, "background job: could not be handed to a watch, its completion will go unreported");
        }
    }
    return handed;
};
