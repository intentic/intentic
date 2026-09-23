import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentJob, profileOf, type TurnProfile, TurnProfileSchema } from "@intentic/sandbox-contract";
import { z } from "zod";
import type { ConversationActors } from "../../agents/actor/conversation-actors.js";
import type { Holding } from "../../agents/actor/conversation-holdings.js";
import { whenFileAppears } from "../../file-appears.js";

// Every `run_in_background` Bash call, which outlives the per-turn CLI in its own pane, held by its conversation's
// actor, whose card lists it (`jobs-shown`).

// Published by atomic rename by bin/tmux-run once the command has exited; its existence is completion.
const STATUS_FILE = "status";
// The pane's combined output, tee'd as it runs.
const OUTPUT_FILE = "out";
// The job itself, rewritten whole as it is named and adopted, so a restarted daemon can take it back.
const JOB_FILE = "job.json";

// Longest a job may hold a terminal and an armed watch, in ms, whether or not it ever exits.
export const JOB_MAX_MS = 6 * 3_600_000;

// Under the reaper's `intentic-run-` tmp sweep.
const JOB_DIR_PREFIX = "intentic-run-job-";

// Longest a command may be where it is quoted back to a person, after folding to one line.
const COMMAND_LINE_CHARS = 120;

// Bytes of output tail a reader is handed.
export const OUTPUT_TAIL_BYTES = 4_000;

// Longest wait, in ms, between a command exiting and its card saying so when the status file's own arrival went unseen.
const END_POLL_MS = 30_000;

// Ended jobs a conversation's card keeps, newest last.
export const ENDINGS_KEPT = 8;

const oneLine = (text: string): string => {
    const line = text.replaceAll(/\s+/gu, " ").trim();
    return line.length <= COMMAND_LINE_CHARS ? line : `${line.slice(0, COMMAND_LINE_CHARS - 1)}…`;
};

/** The job's command as one readable line. */
export const jobCommandLine = (command: string): string => oneLine(command);

/** What a person is shown the job as: the agent's own description of the call, else its command. */
export const jobLabel = (description: string | undefined, command: string): string => {
    const said = oneLine(description ?? "");
    return said === "" ? jobCommandLine(command) : said;
};

// The conversation a job's completion wakes, and the turn it wakes it as.
export interface BackgroundJobSeed {
    readonly conversationId: string;
    // Snapshotted at open: the turn is gone by the time the job ends.
    readonly profile: TurnProfile;
    // The actors its conversation lives in, which hold the job and show it on the card.
    readonly conversations: Actors;
}

// A job file is read back by a later daemon, so it is validated, never trusted. `turn` holds the opening turn's profile.
const JobFileSchema = z.object({
    id: z.string(),
    conversationId: z.string(),
    command: z.string(),
    label: z.string(),
    session: z.string(),
    startedAt: z.number(),
    turn: TurnProfileSchema,
    // The SDK's background task id, the one the model knows the job by.
    shellId: z.string().optional(),
    // Whether its completion was handed to a watch; a restored unadopted job is adopted at boot.
    adopted: z.boolean().optional(),
});

export interface BackgroundJob {
    readonly id: string;
    readonly conversationId: string;
    // The agent's own command line, never the daemon's wrapped one.
    readonly command: string;
    readonly label: string;
    // Capture dir holding the status, the output and the job file.
    readonly dir: string;
    // tmux session holding the pane, which the reaper must spare.
    readonly session: string;
    readonly startedAt: number;
    readonly profile: TurnProfile;
}

// The CLI queues a completion notice when the command exits; only a later model request reads it.
type Notice = "none" | "queued" | "read";

interface JobRecord {
    readonly job: BackgroundJob;
    adopted: boolean;
    shellId: string | undefined;
    toolUseId: string | undefined;
    notice: Notice;
    // Stops watching for the status file; the card moves the moment it lands.
    unwatch: (() => void) | undefined;
}

// A conversation's jobs, by job id, until nothing depends on one any more.
const JOBS: Holding<JobRecord> = { name: "background jobs" };
// How its recent jobs ended, by job id, newest last: apart from JOBS, which forgets a job the moment nothing depends on
// it.
const ENDINGS: Holding<AgentJob> = { name: "job endings" };
// The one poll that notices every conversation's exits; the fleet's, so held by none of them.
const END_POLL: Holding<NodeJS.Timeout> = { name: "job end poll" };
const END_POLL_ID = "end-poll";

type Actors = Pick<ConversationActors, "holdings" | "send">;
// What a reader of the jobs needs of them, which writes nothing to a card.
type Holders = Pick<ConversationActors, "holdings">;

export const jobStatusPath = (job: BackgroundJob): string => join(job.dir, STATUS_FILE);
export const jobOutputPath = (job: BackgroundJob): string => join(job.dir, OUTPUT_FILE);

/** Whether the command has exited; never half-true, since the status file is renamed into place last. */
export const jobFinished = (job: BackgroundJob): boolean => existsSync(jobStatusPath(job));

const cardOf = (job: BackgroundJob): AgentJob => ({ id: job.id, label: job.label, session: job.session, startedAt: job.startedAt });

// The status file's own mtime is the exit, however late it is noticed; its body is the exit code.
const endOf = (job: BackgroundJob): AgentJob => {
    try {
        const code = Number(readFileSync(jobStatusPath(job), "utf8").trim());
        // Clamped to the start: a filesystem clock coarser than Date.now() can date a quick exit before it began.
        const endedAt = Math.max(job.startedAt, Math.round(statSync(jobStatusPath(job)).mtimeMs));
        return { ...cardOf(job), endedAt, ...(Number.isInteger(code) ? { exitCode: code } : {}) };
    } catch {
        return { ...cardOf(job), endedAt: Date.now() };
    }
};

const ended = (actors: Actors, job: BackgroundJob): boolean => actors.holdings(ENDINGS).has(job.id);

// Once per job; answers whether this call was the one that wrote it down.
const noteEnded = (actors: Actors, job: BackgroundJob): boolean => {
    if (ended(actors, job)) {
        return false;
    }
    const endings = actors.holdings(ENDINGS);
    endings.hold(job.conversationId, job.id, endOf(job));
    for (const stale of endings.of(job.conversationId).slice(0, -ENDINGS_KEPT)) {
        endings.drop(stale.id);
    }
    return true;
};

const publish = (actors: Actors, conversationId: string): void => {
    const running = actors
        .holdings(JOBS)
        .of(conversationId)
        .filter((record) => !ended(actors, record.job))
        .map((record) => cardOf(record.job));
    actors.send(conversationId, { kind: "jobs-shown", jobs: [...running, ...actors.holdings(ENDINGS).of(conversationId)] });
};

const sweepEnds = (actors: Actors): void => {
    const jobs = actors.holdings(JOBS).entries();
    const moved = new Set<string>();
    for (const [, record] of jobs) {
        if (!ended(actors, record.job) && jobFinished(record.job) && noteEnded(actors, record.job)) {
            record.unwatch?.();
            record.unwatch = undefined;
            moved.add(record.job.conversationId);
        }
    }
    for (const conversationId of moved) {
        publish(actors, conversationId);
    }
    const poll = actors.holdings(END_POLL);
    const timer = poll.get(END_POLL_ID);
    if (timer !== undefined && !jobs.some(([, record]) => !ended(actors, record.job))) {
        clearInterval(timer);
        poll.drop(END_POLL_ID);
    }
};

/** Writes down every job that exited since the last look, and publishes the conversations it moved. */
export const sweepJobEnds = (actors: Actors): void => sweepEnds(actors);

// One timer for every running job, stopped once none is left; unref'd, since a job never holds the daemon up. It
// sweeps the fleet that armed it.
const followEnds = (actors: Actors): void => {
    const poll = actors.holdings(END_POLL);
    if (!poll.has(END_POLL_ID)) {
        const timer = setInterval(() => sweepEnds(actors), END_POLL_MS);
        timer.unref();
        poll.hold(undefined, END_POLL_ID, timer);
    }
};

const followJob = (actors: Actors, record: JobRecord): void => {
    record.unwatch = whenFileAppears(jobStatusPath(record.job), () => sweepEnds(actors));
    followEnds(actors);
};

// Every path out of JOBS comes through here, so a job that exited is written down before it is forgotten.
const forgetJob = (actors: Actors, record: JobRecord): void => {
    actors.holdings(JOBS).drop(record.job.id);
    record.unwatch?.();
    record.unwatch = undefined;
    if (jobFinished(record.job)) {
        noteEnded(actors, record.job);
    }
    publish(actors, record.job.conversationId);
};

// Sibling temp plus rename, so a reader after a crash finds one whole version or the other.
const persist = (record: JobRecord): void => {
    const { dir: _dir, profile, ...job } = record.job;
    const file = join(record.job.dir, JOB_FILE);
    try {
        writeFileSync(
            `${file}.tmp`,
            JSON.stringify({
                ...job,
                turn: profile,
                ...(record.shellId === undefined ? {} : { shellId: record.shellId }),
                ...(record.adopted ? { adopted: true } : {}),
            }),
            { mode: 0o600 },
        );
        renameSync(`${file}.tmp`, file);
    } catch {
        // Only a restart under the job would miss what this write carried.
    }
};

/** Undefined when the dir cannot be made, leaving the command an ordinary one; `toolUseId` pairs it with its shell id later. */
export const openBackgroundJob = (
    seed: BackgroundJobSeed,
    spec: { readonly command: string; readonly session: string; readonly description?: string; readonly toolUseId?: string },
): BackgroundJob | undefined => {
    const id = randomUUID();
    const dir = join(tmpdir(), `${JOB_DIR_PREFIX}${id}`);
    try {
        // Made before the pane, since a watch on a dir that does not exist yet reads as broken.
        mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch {
        return undefined;
    }
    const job: BackgroundJob = {
        id,
        conversationId: seed.conversationId,
        command: spec.command,
        label: jobLabel(spec.description, spec.command),
        dir,
        session: spec.session,
        startedAt: Date.now(),
        profile: seed.profile,
    };
    const record: JobRecord = { job, adopted: false, shellId: undefined, toolUseId: spec.toolUseId, notice: "none", unwatch: undefined };
    const actors = seed.conversations;
    actors.holdings(JOBS).hold(job.conversationId, id, record);
    persist(record);
    publish(actors, job.conversationId);
    followJob(actors, record);
    return job;
};

// Undefined for anything that is not a job file; never throws, so a bad entry cannot fail a boot.
const recordOf = (dir: string): JobRecord | undefined => {
    try {
        const parsed = JobFileSchema.safeParse(JSON.parse(readFileSync(join(dir, JOB_FILE), "utf8")));
        if (!parsed.success) {
            return undefined;
        }
        const { shellId, adopted, turn, ...rest } = parsed.data;
        return {
            job: { ...rest, dir, profile: profileOf(turn) },
            adopted: adopted === true,
            shellId,
            toolUseId: undefined,
            notice: "none",
            unwatch: undefined,
        };
    } catch {
        return undefined;
    }
};

/** Once at boot: re-files the still-running jobs a dead daemon left, each as adopted as its own file says. */
export const restoreBackgroundJobs = (actors: Actors, now: number = Date.now()): readonly BackgroundJob[] => {
    const jobs = actors.holdings(JOBS);
    const restored: BackgroundJob[] = [];
    for (const entry of readdirSync(tmpdir(), { withFileTypes: true }).filter((candidate) => candidate.isDirectory() && candidate.name.startsWith(JOB_DIR_PREFIX))) {
        const record = recordOf(join(tmpdir(), entry.name));
        if (record === undefined || jobs.has(record.job.id) || jobFinished(record.job) || now - record.job.startedAt > JOB_MAX_MS) {
            continue;
        }
        jobs.hold(record.job.conversationId, record.job.id, record);
        restored.push(record.job);
        followJob(actors, record);
    }
    for (const conversationId of new Set(restored.map((job) => job.conversationId))) {
        publish(actors, conversationId);
    }
    return restored;
};

// The stream's facts about a job, in arrival order: named, its completion notice queued, that notice read.

/** From the CLI's `task_started` for the Bash call that opened the job. */
export const noteJobShell = (actors: Holders, toolUseId: string, shellId: string): void => {
    for (const [, record] of actors.holdings(JOBS).entries()) {
        if (record.toolUseId === toolUseId) {
            record.shellId = shellId;
            persist(record);
            return;
        }
    }
};

/** From the CLI's `task_notification`. */
export const noteJobNotice = (actors: Holders, shellId: string): void => {
    for (const [, record] of actors.holdings(JOBS).entries()) {
        if (record.shellId === shellId && record.notice === "none") {
            record.notice = "queued";
        }
    }
};

/** A main-thread model request reads every completion notice queued before it. */
export const noteModelRequest = (actors: Holders, conversationId: string): void => {
    for (const record of actors.holdings(JOBS).of(conversationId)) {
        if (record.notice === "queued") {
            record.notice = "read";
        }
    }
};

export interface SettledJobs {
    // Still running when the turn ended.
    readonly running: readonly BackgroundJob[];
    // Finished with a completion notice the model never read.
    readonly unseen: readonly BackgroundJob[];
}

/** A settled turn's jobs, each handed out once; a job whose completion the model read retires here. */
export const settledBackgroundJobs = (actors: Actors, conversationId: string): SettledJobs => {
    const running: BackgroundJob[] = [];
    const unseen: BackgroundJob[] = [];
    for (const record of actors.holdings(JOBS).of(conversationId)) {
        if (jobFinished(record.job)) {
            forgetJob(actors, record);
            if (record.notice !== "read" && !record.adopted) {
                unseen.push(record.job);
            }
            continue;
        }
        if (record.adopted) {
            continue;
        }
        record.adopted = true;
        persist(record);
        running.push(record.job);
    }
    return { running, unseen };
};

/** tmux sessions holding a still-running job, for the reaper to spare; prunes finished and expired records. */
export const backgroundJobSessions = (actors: Actors, now: number = Date.now()): ReadonlySet<string> => {
    const live = new Set<string>();
    for (const [, record] of actors.holdings(JOBS).entries()) {
        if (jobFinished(record.job) || now - record.job.startedAt > JOB_MAX_MS) {
            forgetJob(actors, record);
            continue;
        }
        live.add(record.job.session);
    }
    return live;
};

/** The conversation's jobs still running, for `wait` on "any". */
export const runningJobsOf = (actors: Holders, conversationId: string): readonly BackgroundJob[] =>
    actors
        .holdings(JOBS)
        .of(conversationId)
        .filter((record) => !jobFinished(record.job))
        .map((record) => record.job);

/** One of the conversation's jobs, by its shell id or its own id. */
export const backgroundJobOf = (actors: Holders, conversationId: string, id: string): BackgroundJob | undefined =>
    actors
        .holdings(JOBS)
        .of(conversationId)
        .find((record) => record.shellId === id || record.job.id === id)?.job;

/** The id the model was given for the job, else the daemon's own. */
export const jobHandle = (actors: Holders, job: BackgroundJob): string => actors.holdings(JOBS).get(job.id)?.shellId ?? job.id;

// Empty when the file cannot be read.
const tailOf = async (path: string, bytes: number): Promise<string> => {
    try {
        const handle = await open(path, "r");
        try {
            const { size } = await handle.stat();
            const length = Math.min(size, bytes);
            const buffer = Buffer.alloc(length);
            await handle.read(buffer, 0, length, size - length);
            return buffer.toString("utf8");
        } finally {
            await handle.close();
        }
    } catch {
        return "";
    }
};

export interface JobReport {
    readonly id: string;
    readonly command: string;
    // Undefined while it runs, or when the status is not a number.
    readonly exitCode: number | undefined;
    readonly running: boolean;
    readonly outputTail: string;
    readonly outputFile: string;
}


export const jobReport = async (actors: Holders, job: BackgroundJob): Promise<JobReport> => {
    const finished = jobFinished(job);
    const status = finished ? (await tailOf(jobStatusPath(job), 64)).trim() : "";
    const code = status === "" ? Number.NaN : Number(status);
    return {
        id: jobHandle(actors, job),
        command: jobCommandLine(job.command),
        exitCode: Number.isInteger(code) ? code : undefined,
        running: !finished,
        outputTail: await tailOf(jobOutputPath(job), OUTPUT_TAIL_BYTES),
        outputFile: jobOutputPath(job),
    };
};
