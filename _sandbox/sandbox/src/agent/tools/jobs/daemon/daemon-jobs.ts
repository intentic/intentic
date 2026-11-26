import { errorMessage } from "@intentic/base/errors";
import type { ConversationActors } from "../../../../conversations/actor/conversation-actors.js";
import { turnRunOf } from "../../../../conversations/actor/conversation-holdings.js";
import { conversationProfile, type PersistedAgent } from "../../../../conversations/registry/agents-store.js";
import { whenFileAppears } from "../../file-appears.js";
import {
    type BackgroundJob,
    type BackgroundJobSeed,
    jobCommandLine,
    jobFinished,
    jobStatusPath,
    OUTPUT_TAIL_BYTES,
    openBackgroundJob,
    sweepJobEnds,
} from "../background-jobs.js";
import { holdDaemonRun, OUTPUT_FILE, STATUS_FILE } from "../job-files.js";
import { appendRunFile, renameRunFile, writeRunFile } from "../run-files.js";

/* WORK THE DAEMON CARRIES ITSELF, FILED AS A BACKGROUND JOB (2026-11-17, the shinobi-society audit). A ChatGPT image made
   in the owner's browser held the agent's turn for minutes per call (four calls averaged 345 s there), so an agent making
   a set of pictures sat idle most of an hour. Such work is now a job like a `run_in_background` command's: the same
   capture dir, output and status files, so `wait` takes its id, the card lists it, a turn ending on it hands it to the
   watch that wakes the conversation with its end (background-adoption.ts), and `stop` ends it. What differs is only who
   writes the end: no runner in a pane, but this process, once `run` settles (job-files.ts holdDaemonRun says why the
   runnerless sweep spares it, and why a restart still writes it down as lost). */

// What the work came to: a success (status 0) or a failure (1), and the words a reader of its end is handed.
export interface DaemonJobEnd {
    readonly ok: boolean;
    readonly output: string;
}

// The job as its work sees it while it runs.
export interface RunningDaemonJob {
    readonly job: BackgroundJob;
    // A line onto what the job shows while it runs (`wait`'s output tail and quiet time), e.g. that it left a queue.
    readonly say: (line: string) => void;
}

export interface DaemonJobSpec {
    // How `wait` and the transcript name it; the card shows `description`.
    readonly command: string;
    readonly description: string;
    // Its output until it ends: what it is doing, and what to do if a restart takes it down meanwhile.
    readonly started: string;
    // `signal` aborts once the job is stopped (its end written by someone else): what it still does is read by nobody.
    readonly run: (signal: AbortSignal, job: RunningDaemonJob) => Promise<DaemonJobEnd>;
}

export interface JobSeedDeps {
    readonly conversations: Pick<ConversationActors, "holdings" | "send">;
    readonly agents: { readonly entry: (id: string) => PersistedAgent | undefined };
    readonly historyRoot: string;
}

/**
 * A conversation's job seed, woken as the conversation's own profile, as a child's report wakes its parent: what a job
 * the daemon carries for a tool call (chatgpt-image-jobs.ts, an extension's, extensions/turn/tool-turn-doors.ts) is filed
 * with. Undefined for a conversation the registry does not know.
 */
export const conversationJobSeeds =
    (deps: JobSeedDeps) =>
    (conversationId: string): BackgroundJobSeed | undefined => {
        const entry = deps.agents.entry(conversationId);
        return entry === undefined ? undefined : { conversationId, profile: conversationProfile(entry), conversations: deps.conversations, historyRoot: deps.historyRoot };
    };

// Room left in what a reader is handed for the marker that says something was cut.
const CUT_MARGIN_BYTES = 200;

/**
 * The whole end within what `wait` and the wake hand over (the last OUTPUT_TAIL_BYTES of the output): a longer one loses
 * its middle, not its head, where the saved file's path is, nor its tail, where a sealed block closes.
 */
export const fittedOutput = (output: string, budget = OUTPUT_TAIL_BYTES - CUT_MARGIN_BYTES): string => {
    if (Buffer.byteLength(output) <= budget) {
        return output;
    }
    let head = Math.floor(budget * 0.6);
    let tail = Math.floor(budget * 0.35);
    for (;;) {
        const text = `${output.slice(0, head)}\n[… ${output.length - head - tail} characters cut here by the sandbox …]\n${output.slice(-tail)}`;
        if (Buffer.byteLength(text) <= budget || head < 100) {
            return text;
        }
        head = Math.floor(head * 0.8);
        tail = Math.floor(tail * 0.8);
    }
};

// Never through a link (run-files.ts); a dir the tmp sweep already took has nobody left to read it.
const tryWrite = (write: () => void): void => {
    try {
        write();
    } catch {
        // allow(silent-catch): a capture dir that cannot be written is one the tmp sweep took, with nobody left to read the job.
    }
};

// Its end, as a runner writes one: the output first, then the status by the atomic rename that is the end.
const endWith = (job: BackgroundJob, end: DaemonJobEnd): void =>
    tryWrite(() => {
        writeRunFile(job.dir, OUTPUT_FILE, `${fittedOutput(end.output.trimEnd())}\n`);
        writeRunFile(job.dir, `${STATUS_FILE}.part`, end.ok ? "0\n" : "1\n");
        renameRunFile(job.dir, `${STATUS_FILE}.part`, STATUS_FILE);
    });

/**
 * Files `spec` as a job of the seed's conversation and runs it in this process; answers the job at once, or undefined
 * when its capture dir cannot be made (the caller then does the work in the call, as before).
 */
export const startDaemonJob = (seed: BackgroundJobSeed, spec: DaemonJobSpec): BackgroundJob | undefined => {
    const job = openBackgroundJob(seed, { command: spec.command, session: "", description: spec.description });
    if (job === undefined) {
        return undefined;
    }
    const release = holdDaemonRun(job.dir);
    // Written before anything else can look: a job with no output yet reads as one that never started (job-files.ts).
    tryWrite(() => writeRunFile(job.dir, OUTPUT_FILE, `${spec.started.trimEnd()}\n`));
    turnRunOf(seed.conversations, job.conversationId)?.note({
        role: "notice",
        text: `Background job: ${job.label}`,
        backgroundJob: { id: job.id, label: job.label, command: jobCommandLine(spec.command), startedAt: job.startedAt },
    });
    const stopped = new AbortController();
    // Its own end lands here too, after `run` settled, when nothing is listening any more.
    const unwatch = whenFileAppears(jobStatusPath(job), () => stopped.abort());
    const running: RunningDaemonJob = { job, say: (line) => tryWrite(() => appendRunFile(job.dir, OUTPUT_FILE, `${line.trimEnd()}\n`)) };
    const ran = async (): Promise<DaemonJobEnd> => {
        try {
            return await spec.run(stopped.signal, running);
        } catch (error) {
            return { ok: false, output: `The job failed in the sandbox: ${errorMessage(error)}` };
        }
    };
    void ran().then((end) => {
        unwatch?.();
        // A stopped job's end is already written (143): what the work came to after that is read by nobody.
        if (!jobFinished(job)) {
            endWith(job, end);
        }
        release();
        sweepJobEnds(seed.conversations);
    });
    return job;
};
