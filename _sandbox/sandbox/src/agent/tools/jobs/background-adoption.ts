import { classifyCommand } from "@intentic/sandbox-contract/policy/command-classes";
import { shellQuote } from "@intentic/sandbox-run/quote";
import type { Logger } from "pino";
import { armWatcher, cancelWatcher, type WatcherSpec } from "../../verification/watchers.js";
import { type BackgroundJob, JOB_MAX_MS, jobOutputPath, jobStatusPath, noteJobWatch, OUTPUT_TAIL_BYTES, settledBackgroundJobs } from "./background-jobs.js";
import { MEMORY_KILL_FILE } from "./job-files.js";
import type { ConversationActors } from "../../../conversations/actor/conversation-actors.js";

// Kept apart from background-jobs.ts, whose importing the watch engine would close a cycle through agent.ts.

// Seconds between completion checks when the status file's own arrival went unseen.
const CHECK_INTERVAL_S = 30;

// Exits 0 only once the status file exists, printing the command's exit code, why it was killed when it was killed for
// memory, and then its output tail. A 137 (SIGKILL) gives the kill's mark (memory-kills.ts) up to three seconds to land,
// since the runner publishes the code the moment the command is gone and the kill's record can land just after: the
// wake then says what killed it rather than a bare code (2026-11-05).
export const completionCheck = (job: BackgroundJob): string => {
    const status = shellQuote(jobStatusPath(job));
    const output = shellQuote(jobOutputPath(job));
    const killed = shellQuote(`${job.dir}/${MEMORY_KILL_FILE}`);
    return [
        `test -f ${status} || exit 1`,
        `code="$(cat ${status})"`,
        `if [ "$code" = 137 ]; then for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do test -f ${killed} && break; sleep 0.2; done; fi`,
        `printf 'exit %s\\n' "$code"`,
        `cat ${killed} 2>/dev/null`,
        `tail -c ${String(OUTPUT_TAIL_BYTES)} ${output} 2>/dev/null`,
        "exit 0",
    ].join("; ");
};

// The headline of the notice row the wake becomes, so it names the job as its own row does.
export const jobNote = (job: BackgroundJob): string => `Background job "${job.label}"`;

// A fetching job's output is outside content, as a fetching Bash result is.
const outsideOf = (job: BackgroundJob): { readonly outside?: string } =>
    classifyCommand(job.command, { locus: "sandbox" }).includes("network.outbound") ? { outside: "shell-fetch" } : {};

const specOf = (job: BackgroundJob): WatcherSpec => ({
    conversationId: job.conversationId,
    command: completionCheck(job),
    note: jobNote(job),
    intervalSeconds: CHECK_INTERVAL_S,
    timeoutSeconds: Math.round(JOB_MAX_MS / 1000),
    // Once the tmp sweep takes this dir, a restored watch wakes as broken rather than waiting on nothing.
    cwd: job.dir,
    // The status file landing is the exit, so the wake goes then, not at the next check.
    signalPath: jobStatusPath(job),
    // The check reads two files and needs no credential.
    env: {},
    ...outsideOf(job),
    profile: job.profile,
});

/**
 * Answers how many jobs it handed to a watch; never throws, since it runs off a turn's ending. `cut`: that turn was cut
 * off (a failure, a restart) rather than ended, so nobody chose to wait on what it left (background-jobs.ts JobRecord.cut).
 */
export const adoptBackgroundJobs = async (
    conversations: Pick<ConversationActors, "holdings" | "send">,
    conversationId: string,
    logger: Logger,
    options: { readonly cut?: boolean } = {},
): Promise<number> => {
    const { running, unseen } = settledBackgroundJobs(conversations, conversationId, options.cut === true);
    let handed = 0;
    for (const job of [...running, ...unseen]) {
        try {
            // A job exiting between the settle and this check still finished after the model's last look.
            const outcome = await armWatcher(specOf(job), { reportIfMet: true });
            if (outcome.kind === "armed" || outcome.kind === "reported") {
                handed += 1;
                // Kept on the job, so stopping it disarms this first and its exit wakes nobody; a job stopped while this
                // armed has nobody left to wake.
                if (outcome.kind === "armed" && !noteJobWatch(conversations, job, outcome.id)) {
                    await cancelWatcher(conversationId, outcome.id);
                }
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
