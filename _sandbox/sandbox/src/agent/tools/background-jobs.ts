import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentHarnessSchema, AgentProviderSchema, ModelRoleSchema } from "@intentic/sandbox-contract";
import { z } from "zod";
import type { TurnSeed } from "../run/turn/turn-seed.js";

// Every `run_in_background` Bash call, which outlives the per-turn CLI in its own pane, filed under its conversation.

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

/** The job's command as one readable line. */
export const jobCommandLine = (command: string): string => {
    const line = command.replaceAll(/\s+/gu, " ").trim();
    return line.length <= COMMAND_LINE_CHARS ? line : `${line.slice(0, COMMAND_LINE_CHARS - 1)}…`;
};

// The conversation a job's completion wakes, and the routing it wakes it on.
export interface BackgroundJobSeed {
    readonly conversationId: string;
    // Snapshotted at open: the turn is gone by the time the job ends.
    readonly turn: TurnSeed;
}

// A job file is read back by a later daemon, so it is validated, never trusted.
const TurnSeedSchema = z.object({
    agent: AgentProviderSchema.optional(),
    harness: AgentHarnessSchema.optional(),
    account: z.string().optional(),
    model: z.string().optional(),
    effort: z.string().optional(),
    thinking: z.boolean().optional(),
    fast: z.boolean().optional(),
    actsAs: z.string().optional(),
    isolated: z.boolean().optional(),
    unattended: z.boolean().optional(),
    runRole: ModelRoleSchema.optional(),
});

const JobFileSchema = z.object({
    id: z.string(),
    conversationId: z.string(),
    command: z.string(),
    session: z.string(),
    startedAt: z.number(),
    turn: TurnSeedSchema,
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
    // Capture dir holding the status, the output and the job file.
    readonly dir: string;
    // tmux session holding the pane, which the reaper must spare.
    readonly session: string;
    readonly startedAt: number;
    readonly turn: TurnSeed;
}

// The CLI queues a completion notice when the command exits; only a later model request reads it.
type Notice = "none" | "queued" | "read";

interface JobRecord {
    readonly job: BackgroundJob;
    adopted: boolean;
    shellId: string | undefined;
    toolUseId: string | undefined;
    notice: Notice;
}

const jobs = new Map<string, JobRecord>();

export const jobStatusPath = (job: BackgroundJob): string => join(job.dir, STATUS_FILE);
export const jobOutputPath = (job: BackgroundJob): string => join(job.dir, OUTPUT_FILE);

/** Whether the command has exited; never half-true, since the status file is renamed into place last. */
export const jobFinished = (job: BackgroundJob): boolean => existsSync(jobStatusPath(job));

// Sibling temp plus rename, so a reader after a crash finds one whole version or the other.
const persist = (record: JobRecord): void => {
    const { dir: _dir, ...job } = record.job;
    const file = join(record.job.dir, JOB_FILE);
    try {
        writeFileSync(
            `${file}.tmp`,
            JSON.stringify({ ...job, ...(record.shellId === undefined ? {} : { shellId: record.shellId }), ...(record.adopted ? { adopted: true } : {}) }),
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
    spec: { readonly command: string; readonly session: string; readonly toolUseId?: string },
): BackgroundJob | undefined => {
    const id = randomUUID();
    const dir = join(tmpdir(), `${JOB_DIR_PREFIX}${id}`);
    try {
        // Made before the pane, since a watch on a dir that does not exist yet reads as broken.
        mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch {
        return undefined;
    }
    const job: BackgroundJob = { id, conversationId: seed.conversationId, command: spec.command, dir, session: spec.session, startedAt: Date.now(), turn: seed.turn };
    const record: JobRecord = { job, adopted: false, shellId: undefined, toolUseId: spec.toolUseId, notice: "none" };
    jobs.set(id, record);
    persist(record);
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
        const seed = Object.fromEntries(Object.entries(turn).filter(([, value]) => value !== undefined)) as TurnSeed;
        return { job: { ...rest, dir, turn: seed }, adopted: adopted === true, shellId, toolUseId: undefined, notice: "none" };
    } catch {
        return undefined;
    }
};

/** Once at boot: re-files the still-running jobs a dead daemon left, each as adopted as its own file says. */
export const restoreBackgroundJobs = (now: number = Date.now()): readonly BackgroundJob[] => {
    const restored: BackgroundJob[] = [];
    for (const entry of readdirSync(tmpdir(), { withFileTypes: true }).filter((candidate) => candidate.isDirectory() && candidate.name.startsWith(JOB_DIR_PREFIX))) {
        const record = recordOf(join(tmpdir(), entry.name));
        if (record === undefined || jobs.has(record.job.id) || jobFinished(record.job) || now - record.job.startedAt > JOB_MAX_MS) {
            continue;
        }
        jobs.set(record.job.id, record);
        restored.push(record.job);
    }
    return restored;
};

// The stream's facts about a job, in arrival order: named, its completion notice queued, that notice read.

/** From the CLI's `task_started` for the Bash call that opened the job. */
export const noteJobShell = (toolUseId: string, shellId: string): void => {
    for (const record of jobs.values()) {
        if (record.toolUseId === toolUseId) {
            record.shellId = shellId;
            persist(record);
            return;
        }
    }
};

/** From the CLI's `task_notification`. */
export const noteJobNotice = (shellId: string): void => {
    for (const record of jobs.values()) {
        if (record.shellId === shellId && record.notice === "none") {
            record.notice = "queued";
        }
    }
};

/** A main-thread model request reads every completion notice queued before it. */
export const noteModelRequest = (conversationId: string): void => {
    for (const record of jobs.values()) {
        if (record.job.conversationId === conversationId && record.notice === "queued") {
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
export const settledBackgroundJobs = (conversationId: string): SettledJobs => {
    const running: BackgroundJob[] = [];
    const unseen: BackgroundJob[] = [];
    for (const [id, record] of jobs) {
        if (record.job.conversationId !== conversationId) {
            continue;
        }
        if (jobFinished(record.job)) {
            jobs.delete(id);
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
export const backgroundJobSessions = (now: number = Date.now()): ReadonlySet<string> => {
    const live = new Set<string>();
    for (const [id, record] of jobs) {
        if (jobFinished(record.job) || now - record.job.startedAt > JOB_MAX_MS) {
            jobs.delete(id);
            continue;
        }
        live.add(record.job.session);
    }
    return live;
};

/** The conversation's jobs still running, for `wait` on "any". */
export const runningJobsOf = (conversationId: string): readonly BackgroundJob[] =>
    [...jobs.values()].filter((record) => record.job.conversationId === conversationId && !jobFinished(record.job)).map((record) => record.job);

/** One of the conversation's jobs, by its shell id or its own id. */
export const backgroundJobOf = (conversationId: string, id: string): BackgroundJob | undefined =>
    [...jobs.values()].find((record) => record.job.conversationId === conversationId && (record.shellId === id || record.job.id === id))?.job;

/** The id the model was given for the job, else the daemon's own. */
export const jobHandle = (job: BackgroundJob): string => jobs.get(job.id)?.shellId ?? job.id;

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


export const jobReport = async (job: BackgroundJob): Promise<JobReport> => {
    const finished = jobFinished(job);
    const status = finished ? (await tailOf(jobStatusPath(job), 64)).trim() : "";
    const code = status === "" ? Number.NaN : Number(status);
    return {
        id: jobHandle(job),
        command: jobCommandLine(job.command),
        exitCode: Number.isInteger(code) ? code : undefined,
        running: !finished,
        outputTail: await tailOf(jobOutputPath(job), OUTPUT_TAIL_BYTES),
        outputFile: jobOutputPath(job),
    };
};
