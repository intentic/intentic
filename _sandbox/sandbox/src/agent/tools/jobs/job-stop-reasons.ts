import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ConversationActors } from "../../../conversations/actor/conversation-actors.js";
import { JOBS, jobFinished, stopBackgroundJob } from "./background-jobs.js";
import { OUTPUT_FILE, STOP_REASON_FILE } from "./job-files.js";
import { appendRunFile, writeRunFile } from "./run-files.js";

/* WHY A JOB WAS STOPPED (2026-11-17, the shinobi-society audit). Claude Code's CLI stops a background command by itself
   at its own time limit (about two hours) or when memory runs short, and the job then ended on a bare exit 143, the code
   any SIGTERM leaves: capture batches there died after ~120 minutes and the agents running them could not tell why, so
   they guessed, re-ran them whole, or polled. The stop's own reason is written down in the job's dir, as a memory kill's
   is (memory-kills.ts), and its report, `wait` and the watch its end wakes all say it beside the code. */

// "45s", "14m", "2h 0m": how long the command had run when it was stopped.
const ranFor = (ms: number): string => {
    const minutes = Math.floor(ms / 60_000);
    if (minutes < 1) {
        return `${String(Math.max(0, Math.floor(ms / 1000)))}s`;
    }
    return minutes < 60 ? `${String(minutes)}m` : `${String(Math.floor(minutes / 60))}h ${String(minutes % 60)}m`;
};

/**
 * The sentence for a stop Claude Code's CLI made by itself. `summary` is the CLI's own words on its task notification,
 * when it gave any: they say which of its limits it was, which the bare status does not.
 */
export const cliStopSentence = (ranMs: number, summary?: string): string => {
    const words = summary?.trim() ?? "";
    const why = /time limit|timed? ?out/i.test(words)
        ? "at its background time limit"
        : /memory/i.test(words)
          ? "because memory was running short"
          : "by itself (its background time limit, about 2 hours, or memory running short)";
    const said = words === "" ? "" : ` (it said: "${words}")`;
    return `stopped by Claude Code ${why} after ${ranFor(ranMs)}${said}, not by the agent or the person. Split it into steps that each finish sooner, or, for a server meant to keep running, hand it to the person with the keep tool, which this limit does not end.`;
};

/** Written once per job, first reason wins; its output says it once too, so a tail read of it explains the 143. */
export const markJobStopped = (dir: string, sentence: string): boolean => {
    if (existsSync(join(dir, STOP_REASON_FILE))) {
        return false;
    }
    try {
        writeRunFile(dir, STOP_REASON_FILE, `${sentence}\n`);
        appendRunFile(dir, OUTPUT_FILE, `\n--- intentic: ${sentence}\n`);
        return true;
    } catch {
        // allow(silent-catch): a capture dir the tmp sweep already took has no ending left to mark.
        return false;
    }
};

/**
 * From a `task_notification` saying the CLI stopped a job by itself: the call's own background time limit, or memory
 * running short. Its stop only signals tmux-run, which under `-b` survives that very signal (it is also how the turn's
 * CLI exits), so the pane ran on while the agent was told the command had stopped: on 2026-10-12 a demo server the CLI
 * "stopped after reaching its background time limit" was still serving 29 minutes later, and the six-hour watch its
 * turn's ending handed it to held that conversation's land the whole time. The job is ended for real here, so what the
 * agent was told is true, and why is written down first, so the 143 it ends on is never read bare. Only a job its turn
 * has not judged yet and nobody kept: one left to the person is theirs, and one already awaited or stopped has its fate.
 * Answers the stop, for a caller that waits on it; undefined when there is nothing to stop.
 */
export const endJobTheCliStopped = (
    actors: Pick<ConversationActors, "holdings" | "send">,
    shellId: string,
    summary?: string,
    now: number = Date.now(),
): Promise<boolean> | undefined => {
    const record = actors
        .holdings(JOBS)
        .entries()
        .map(([, candidate]) => candidate)
        .find((candidate) => candidate.shellId === shellId);
    if (record === undefined || record.fate !== undefined || record.kept !== undefined || jobFinished(record.job)) {
        return undefined;
    }
    markJobStopped(record.job.dir, cliStopSentence(now - record.job.startedAt, summary));
    return stopBackgroundJob(actors, record.job, "agent");
};
