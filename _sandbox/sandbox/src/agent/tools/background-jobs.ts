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
import { publishRuntimeChange } from "../../seams/runtime-feed.js";
import { endSession } from "../../seams/session-processes.js";
import { jobRunnerPids } from "./job-processes.js";

// Every `run_in_background` Bash call, which outlives the per-turn CLI in its own pane, held by its conversation's
// actor, whose card lists it (`jobs-shown`).

// Published by atomic rename by bin/tmux-run once the command has exited; its existence is completion.
const STATUS_FILE = "status";
// The pane's combined output, tee'd as it runs.
const OUTPUT_FILE = "out";
// Written by bin/tmux-run before it touches tmux; its absence once the turn is gone means the command never ran.
const COMMAND_FILE = "cmd";
// The status body of a job whose command never ran, which no exit code can be.
const NEVER_RAN = "never-ran";
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
    // Left running for the person instead (job-fates.ts); never adopted, restart or not.
    handed: z.boolean().optional(),
    ports: z.array(z.number().int()).optional(),
    // The watch it was handed to, which a stop disarms before it ends the job.
    watch: z.string().optional(),
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

// What became of a job its turn left running, decided when a turn ends (job-fates.ts) and never undone: `awaited` is
// handed to a watch whose wake reports its exit; `handed` was left running for the person; `stopped` is being ended.
// Undefined while the turn that started it is still going.
type JobFate = "awaited" | "handed" | "stopped";

// Who ended a job that did not exit by itself.
export type JobStopper = NonNullable<AgentJob["stoppedBy"]>;

interface JobRecord {
    readonly job: BackgroundJob;
    fate: JobFate | undefined;
    shellId: string | undefined;
    toolUseId: string | undefined;
    notice: Notice;
    // Stops watching for the status file; the card moves the moment it lands.
    unwatch: (() => void) | undefined;
    // The watch an `awaited` job was handed to.
    watch: string | undefined;
    // Where a `handed` job listens.
    ports: readonly number[] | undefined;
    stoppedBy: JobStopper | undefined;
    // The last run whose ending judged it, so the two looks one ending takes (before the land, at the settle) judge once.
    judged: string | undefined;
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

// Either file is tmux-run's first act, the pane path writing `cmd` and the no-tmux fallback `out`.
const jobStarted = (job: BackgroundJob): boolean => existsSync(join(job.dir, COMMAND_FILE)) || existsSync(jobOutputPath(job));

// Longest a stopped job's runner gets to publish its own status, once its command has been signalled.
const END_WAIT_MS = 2_000;

// The status a SIGTERMed command leaves (128 + 15), for a stopped job whose runner could not write its own.
const STOPPED_STATUS = "143";

// Ends a job no runner will end, the way tmux-run ends one: `output` replaces what it printed, then the status lands by
// the same atomic rename, so the card, the watch and `wait` all see it end.
const endInPlace = (job: BackgroundJob, status: string, output?: string): void => {
    try {
        if (output !== undefined) {
            writeFileSync(jobOutputPath(job), output);
        }
        writeFileSync(`${jobStatusPath(job)}.part`, `${status}\n`);
        renameSync(`${jobStatusPath(job)}.part`, jobStatusPath(job));
    } catch {
        // A dir that cannot be written is one the tmp sweep already took.
    }
};

// A job whose command never ran.
const endNeverRan = (job: BackgroundJob): void => endInPlace(job, NEVER_RAN, "--- intentic: this command never reached a terminal, so it never ran\n");

const cardOf = (record: JobRecord): AgentJob => {
    const { job } = record;
    return {
        id: job.id,
        label: job.label,
        session: job.session,
        startedAt: job.startedAt,
        ...(record.fate === "awaited" && record.watch !== undefined ? { watch: record.watch } : {}),
        ...(record.fate === "handed" ? { handed: true } : {}),
        ...(record.ports === undefined ? {} : { ports: [...record.ports] }),
        ...(record.stoppedBy === undefined ? {} : { stoppedBy: record.stoppedBy }),
    };
};

// The status file's own mtime is the exit, however late it is noticed; its body is the exit code.
const endOf = (record: JobRecord): AgentJob => {
    const { job } = record;
    // What it was waiting on, or left running for, is over once it ends; who stopped it is what stays worth saying.
    const { watch: _watch, handed: _handed, ...card } = cardOf(record);
    try {
        const code = Number(readFileSync(jobStatusPath(job), "utf8").trim());
        // Clamped to the start: a filesystem clock coarser than Date.now() can date a quick exit before it began.
        const endedAt = Math.max(job.startedAt, Math.round(statSync(jobStatusPath(job)).mtimeMs));
        return { ...card, endedAt, ...(Number.isInteger(code) ? { exitCode: code } : {}) };
    } catch {
        return { ...card, endedAt: Date.now() };
    }
};

const ended = (actors: Actors, job: BackgroundJob): boolean => actors.holdings(ENDINGS).has(job.id);

// Once per job; answers whether this call was the one that wrote it down.
const noteEnded = (actors: Actors, record: JobRecord): boolean => {
    const { job } = record;
    if (ended(actors, job)) {
        return false;
    }
    const endings = actors.holdings(ENDINGS);
    endings.hold(job.conversationId, job.id, endOf(record));
    // A server left for the person is on the ports list by its job's name (ports.routes.ts), which this takes off.
    if (record.fate === "handed" || record.ports !== undefined) {
        publishRuntimeChange("ports");
    }
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
        .map(cardOf);
    actors.send(conversationId, { kind: "jobs-shown", jobs: [...running, ...actors.holdings(ENDINGS).of(conversationId)] });
};

const sweepEnds = (actors: Actors): void => {
    const jobs = actors.holdings(JOBS).entries();
    const moved = new Set<string>();
    for (const [, record] of jobs) {
        if (!ended(actors, record.job) && jobFinished(record.job) && noteEnded(actors, record)) {
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
        noteEnded(actors, record);
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
                ...(record.fate === "awaited" ? { adopted: true } : {}),
                ...(record.fate === "handed" ? { handed: true } : {}),
                ...(record.ports === undefined ? {} : { ports: [...record.ports] }),
                ...(record.watch === undefined ? {} : { watch: record.watch }),
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
    const record: JobRecord = { ...UNJUDGED, job, shellId: undefined, toolUseId: spec.toolUseId };
    const actors = seed.conversations;
    actors.holdings(JOBS).hold(job.conversationId, id, record);
    persist(record);
    publish(actors, job.conversationId);
    followJob(actors, record);
    return job;
};

// A record as its job starts: nothing decided about it, nothing it waits on, nobody told of its end.
const UNJUDGED = {
    fate: undefined,
    notice: "none",
    unwatch: undefined,
    watch: undefined,
    ports: undefined,
    stoppedBy: undefined,
    judged: undefined,
} as const satisfies Omit<JobRecord, "job" | "shellId" | "toolUseId">;

// Undefined for anything that is not a job file; never throws, so a bad entry cannot fail a boot.
const recordOf = (dir: string): JobRecord | undefined => {
    try {
        const parsed = JobFileSchema.safeParse(JSON.parse(readFileSync(join(dir, JOB_FILE), "utf8")));
        if (!parsed.success) {
            return undefined;
        }
        const { shellId, adopted, handed, ports, watch, turn, ...rest } = parsed.data;
        return {
            ...UNJUDGED,
            job: { ...rest, dir, profile: profileOf(turn) },
            fate: handed === true ? "handed" : adopted === true ? "awaited" : undefined,
            shellId,
            toolUseId: undefined,
            watch,
            ports,
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
        // No turn survives a restart, so a job that had not started by then never will.
        if (record !== undefined && !jobStarted(record.job)) {
            endNeverRan(record.job);
        }
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

/**
 * A settled turn's jobs, each handed out once; a job whose completion the model read retires here. Only a job its
 * turn's ending left undecided is handed out: one left running for the person, or being stopped, wakes nothing.
 */
export const settledBackgroundJobs = (actors: Actors, conversationId: string): SettledJobs => {
    const running: BackgroundJob[] = [];
    const unseen: BackgroundJob[] = [];
    for (const record of actors.holdings(JOBS).of(conversationId)) {
        // The turn's CLI is gone, so a call that had not reached tmux-run by now never will.
        if (!jobStarted(record.job)) {
            endNeverRan(record.job);
        }
        if (jobFinished(record.job)) {
            forgetJob(actors, record);
            if (record.notice !== "read" && record.fate === undefined) {
                unseen.push(record.job);
            }
            continue;
        }
        if (record.fate !== undefined) {
            continue;
        }
        record.fate = "awaited";
        persist(record);
        running.push(record.job);
    }
    return { running, unseen };
};

/**
 * Whether something already armed runs the conversation again by itself: a watch, or a job `settledBackgroundJobs`
 * would still hand to one. A job whose watch was stopped keeps running but wakes nothing, and so does one left running
 * for the person or being stopped.
 */
export const wakesItself = (actors: Pick<ConversationActors, "holdings" | "state">, conversationId: string): boolean =>
    (actors.state(conversationId)?.watches.length ?? 0) > 0 ||
    actors
        .holdings(JOBS)
        .of(conversationId)
        .some((record) => record.fate === undefined && (!jobFinished(record.job) || record.notice !== "read"));

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

/**
 * Records the watch an awaited job was handed to, so a stop can disarm it before the exit it waits on fires it. False
 * when the job is no longer awaited (stopped, or gone) by the time its watch armed, which the caller then disarms.
 */
export const noteJobWatch = (actors: Actors, job: BackgroundJob, watchId: string): boolean => {
    const record = actors.holdings(JOBS).get(job.id);
    if (record?.fate !== "awaited") {
        return false;
    }
    record.watch = watchId;
    persist(record);
    publish(actors, job.conversationId);
    return true;
};

/** A job the ending of one turn still has to decide about: running, and neither handed over nor being stopped. */
export interface JudgedJob {
    readonly job: BackgroundJob;
    // The call that started it, so its own command line is never read as the agent using what it started.
    readonly toolUseId: string | undefined;
}

/** The conversation's jobs one run's ending has not judged yet; claims them for that run, so each is judged once. */
export const jobsToJudge = (actors: Holders, conversationId: string, runId: string): readonly JudgedJob[] => {
    const judged: JudgedJob[] = [];
    for (const record of actors.holdings(JOBS).of(conversationId)) {
        if (record.judged === runId || jobFinished(record.job) || (record.fate !== undefined && record.fate !== "awaited")) {
            continue;
        }
        record.judged = runId;
        judged.push({ job: record.job, toolUseId: record.toolUseId });
    }
    return judged;
};

/** Where a running job's pane leads a session, for the dirs that have one; the pid is the session's id. */
export const jobPanes = (jobs: readonly BackgroundJob[]): Promise<Map<string, number>> => jobRunnerPids(jobs.map((job) => job.dir));

/**
 * Leaves a running job to the person: it outlives the turn, wakes nothing and holds no land. Answers the watch it was
 * handed to, if an earlier ending handed it to one, for the caller to disarm.
 */
export const handJobOver = (actors: Actors, job: BackgroundJob, ports: readonly number[]): string | undefined => {
    const record = actors.holdings(JOBS).get(job.id);
    if (record === undefined || jobFinished(job)) {
        return undefined;
    }
    const watch = record.watch;
    record.fate = "handed";
    record.ports = ports;
    record.watch = undefined;
    // Nobody is owed a report of its exit now: the person holds it, and stopping it is theirs.
    record.notice = "read";
    persist(record);
    publish(actors, job.conversationId);
    // Preview offers it by its job's name from here on.
    publishRuntimeChange("ports");
    return watch;
};

/** Every port the conversation's running jobs were left listening on for the person. */
export const handedPorts = (actors: Holders, conversationId: string): ReadonlySet<number> =>
    new Set(
        actors
            .holdings(JOBS)
            .of(conversationId)
            .filter((record) => record.fate === "handed" && !jobFinished(record.job))
            .flatMap((record) => record.ports ?? []),
    );

/** The running job left for the person on this port, whichever conversation left it, as the port's row names it. */
export const portJobOf = (actors: Holders, port: number): { readonly conversationId: string; readonly jobId: string; readonly label: string } | undefined => {
    const job = actors
        .holdings(JOBS)
        .entries()
        .map(([, record]) => record)
        .find((record) => record.fate === "handed" && record.ports?.includes(port) === true && !jobFinished(record.job))?.job;
    return job === undefined ? undefined : { conversationId: job.conversationId, jobId: job.id, label: job.label };
};

// The runner publishes the status once its command is gone; this gives it the moment that takes.
const untilFinished = async (job: BackgroundJob, ms: number): Promise<void> => {
    const deadline = Date.now() + ms;
    while (!jobFinished(job) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50).unref());
    }
};

/**
 * Ends a job, whoever asks: its watch is disarmed first through `disarm` (the watch engine is not importable from
 * here, and it must not reject), so its exit wakes nothing, and the card says who stopped it the moment the stop is asked. Resolves once the
 * job has ended, or once nothing is left that could end it; answers false for a job that had already ended.
 */
export const stopBackgroundJob = async (
    actors: Actors,
    job: BackgroundJob,
    by: JobStopper,
    disarm?: (conversationId: string, watchId: string) => Promise<unknown>,
): Promise<boolean> => {
    const record = actors.holdings(JOBS).get(job.id);
    if (record === undefined || jobFinished(job)) {
        return false;
    }
    const watch = record.watch;
    record.fate = "stopped";
    record.stoppedBy = by;
    record.watch = undefined;
    record.notice = "read";
    publish(actors, job.conversationId);
    if (watch !== undefined && disarm !== undefined) {
        await disarm(job.conversationId, watch);
    }
    const leader = (await jobRunnerPids([job.dir])).get(job.dir);
    if (leader !== undefined && (await endSession(leader))) {
        await untilFinished(job, END_WAIT_MS);
    }
    // No pane left to run it (a tmux-less run, a pane already closed): its end is written down on its runner's behalf,
    // with the code a SIGTERM leaves.
    if (!jobFinished(job)) {
        endInPlace(job, STOPPED_STATUS);
    }
    sweepEnds(actors);
    return true;
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
