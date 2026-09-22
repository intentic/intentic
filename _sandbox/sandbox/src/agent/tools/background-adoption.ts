import { shellQuote } from "@intentic/sandbox-run/quote";
import type { Logger } from "pino";
import { armWatcher } from "../verification/watchers.js";
import { adoptableBackgroundJobs, type BackgroundJob, jobCommandLine, JOB_MAX_MS, jobOutputPath, jobStatusPath } from "./background-jobs.js";

// What a turn's ending does with the background jobs it leaves running: hands each to the daemon's condition watch, so
// the conversation is woken with the job's exit code and output tail whenever the command actually finishes. The watch
// is the right vehicle rather than a second mechanism — it already journals, restores across a daemon restart, shows on
// the fleet card while it waits, and delivers into a live turn or opens one. This module is what nobody had: the step
// that turns "a job is still running" into a wake somebody will receive.
//
// Kept apart from background-jobs.ts so the registry stays a leaf: the Bash hook that fills it is reached from agent.ts,
// which watchers.ts reaches through turn-resume.ts, and importing the watch engine from there would close that cycle.

// Tail carried into the wake: enough for the error that ended a build, small enough to leave room for acting on it.
const OUTPUT_TAIL_BYTES = 4_000;

// How often a finished job is noticed. Slower than a watch's default, because the answer arrives whenever it arrives
// and every check is a process; fast enough that nobody waits on a job that ended.
const CHECK_INTERVAL_S = 30;

// Exits 0 only once bin/tmux-run has published the status file, and prints what the wake should carry: the command's
// real exit code first, then the tail of its output. Non-zero while the job is still running, which is the watch's
// "keep waiting".
export const completionCheck = (job: BackgroundJob): string => {
    const status = shellQuote(jobStatusPath(job));
    const output = shellQuote(jobOutputPath(job));
    return `test -f ${status} || exit 1; printf 'exit %s\\n' "$(cat ${status})"; tail -c ${String(OUTPUT_TAIL_BYTES)} ${output} 2>/dev/null; exit 0`;
};

// Reads as a headline on the notice row the wake becomes: "<note> — the watch fired after 42m."
export const jobNote = (job: BackgroundJob): string => `background job left running when the turn ended: \`${jobCommandLine(job.command)}\``;

/**
 * Arms one watch per still-running job of a settled conversation. Answers how many it armed, for the log and the tests;
 * never throws, since this runs off a turn's ending and must not be able to break one.
 */
export const adoptBackgroundJobs = async (conversationId: string, logger: Logger): Promise<number> => {
    const pending = adoptableBackgroundJobs(conversationId);
    let armed = 0;
    for (const job of pending) {
        try {
            const outcome = await armWatcher({
                conversationId,
                command: completionCheck(job),
                note: jobNote(job),
                intervalSeconds: CHECK_INTERVAL_S,
                timeoutSeconds: Math.round(JOB_MAX_MS / 1000),
                // The job's own dir: alive exactly as long as the job matters, so a restored watch whose dir the tmp
                // sweep already took is dropped rather than re-armed on a job nobody can read.
                cwd: job.dir,
                // The check reads two files and needs no credential; an empty env is also an empty `envKeys` on disk.
                env: {},
                turn: job.turn,
            });
            if (outcome.kind === "armed") {
                armed += 1;
                logger.info({ conversationId, job: job.id, watch: outcome.id, session: job.session }, "background job: adopted, its completion will wake the conversation");
                continue;
            }
            // `already-met` means the command exited in the gap between the turn's last breath and this call, so the
            // turn most likely already reported it; the dir keeps the output either way.
            logger.info({ conversationId, job: job.id, outcome: outcome.kind, dir: job.dir }, "background job: not adopted");
        } catch (error) {
            logger.warn({ err: error, conversationId, job: job.id }, "background job: could not be adopted, its completion will go unreported");
        }
    }
    return armed;
};
