import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnSeed } from "../run/turn/turn-seed.js";

// Every Bash call made with `run_in_background: true`, filed under its conversation so the turn's ending can hand the
// job to a daemon watch (background-adoption.ts) instead of leaving it to be killed.
//
// WHY THIS EXISTS. Intentic runs each turn as its own short-lived CLI process, and that process SIGTERMs its background
// shells as it exits — while the SDK's own Bash description, and this harness's waiting guidance, both promise a
// background command "keeps running across turns" and re-invokes the agent when it exits. In interactive Claude Code
// that is true, because one CLI spans every turn. Here it was false by fifteen seconds: bin/tmux-run turned the
// teardown SIGTERM into `tmux kill-window` and the job died with its pane, silently, leaving no record, no output and
// no notice. Agents then armed watches on files the dead job was supposed to write and waited hours for a wake that
// could never come. The pane now outlives the wrapper (bin/tmux-run -b); this registry is what remembers that it did.
//
// Two readers besides the adoption: the turn that opened the job (through the Bash hook) and the resource reaper, which
// would otherwise kill the job's terminal ten minutes after the conversation stopped.

// Published by atomic rename by bin/tmux-run once the command has exited; its existence IS completion.
const STATUS_FILE = "status";
// The pane's combined output, tee'd as it runs, so a wake can carry a tail even for a job still going.
const OUTPUT_FILE = "out";
// What the job IS, beside its output: written at open so a daemon that dies under a running job can find it again.
// This container recreates itself on every update and environment approval, and a registry held only in memory would
// hand the reaper a terminal it must not touch (the watch itself survives: it has a journal of its own).
const JOB_FILE = "job.json";

// Longest a stopped conversation's job may hold a terminal and an armed watch. Past this the job is the leak this was
// meant not to be, and the record retires whether or not the command ever exited.
export const JOB_MAX_MS = 6 * 3_600_000;

// Shares the reaper's `intentic-run-` tmp sweep, so a dir no wake ever read is reclaimed on the same 24h clock.
const JOB_DIR_PREFIX = "intentic-run-job-";

// Longest a command may be where it is quoted back to a person (a notice row, a wake's headline); past this the line
// stops being one. A heredoc-shaped job is folded to a single line first.
const COMMAND_LINE_CHARS = 120;

/** The job's command as one readable line, for every place that names it to a reader. */
export const jobCommandLine = (command: string): string => {
    const line = command.replaceAll(/\s+/gu, " ").trim();
    return line.length <= COMMAND_LINE_CHARS ? line : `${line.slice(0, COMMAND_LINE_CHARS - 1)}…`;
};

// What a wake needs to continue the turn that started the job: the conversation to wake and the routing to wake it on.
export interface BackgroundJobSeed {
    readonly conversationId: string;
    // Snapshotted at open, since the turn is long gone by the time the job ends (same reason WatcherTurnSeed exists).
    readonly turn: TurnSeed;
}

export interface BackgroundJob {
    readonly id: string;
    readonly conversationId: string;
    // The agent's own command line, for the note a wake carries; never the daemon's wrapped one.
    readonly command: string;
    // Capture dir, minted here so the daemon can read a completion the turn will not be alive to see.
    readonly dir: string;
    // tmux session holding the pane, the fact the reaper needs and can learn nowhere else.
    readonly session: string;
    readonly startedAt: number;
    readonly turn: TurnSeed;
}

// `adopted` guards against a second settle (a steer, a wake, a retry) arming a second watch for one job.
interface JobRecord {
    readonly job: BackgroundJob;
    adopted: boolean;
}

const jobs = new Map<string, JobRecord>();

export const jobStatusPath = (job: BackgroundJob): string => join(job.dir, STATUS_FILE);
export const jobOutputPath = (job: BackgroundJob): string => join(job.dir, OUTPUT_FILE);

/** Whether the command has exited: the status file is written last and by rename, so this is never half-true. */
export const jobFinished = (job: BackgroundJob): boolean => existsSync(jobStatusPath(job));

/**
 * Mints one background job's capture dir and files it under the conversation. Undefined when the dir cannot be made —
 * the caller then runs the command as an ordinary one, which is the pre-existing behaviour, not a new failure.
 */
export const openBackgroundJob = (seed: BackgroundJobSeed, spec: { readonly command: string; readonly session: string }): BackgroundJob | undefined => {
    const id = randomUUID();
    const dir = join(tmpdir(), `${JOB_DIR_PREFIX}${id}`);
    try {
        // Made by the daemon, not the pane: the adoption's watch runs its check in this dir, and a cwd that does not
        // exist yet reads as a failed check rather than as "still waiting".
        mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch {
        return undefined;
    }
    const job: BackgroundJob = { id, conversationId: seed.conversationId, command: spec.command, dir, session: spec.session, startedAt: Date.now(), turn: seed.turn };
    try {
        writeFileSync(join(dir, JOB_FILE), JSON.stringify(job), { mode: 0o600 });
    } catch {
        // The job still runs and the turn still gets its result; only a restart under it would forget the terminal.
    }
    jobs.set(id, { job, adopted: false });
    return job;
};

// One `job.json` as a job, or undefined for anything that is not one: a half-written file, a dir from an older build,
// a shape that has since changed. Nothing here throws — a bad entry is skipped, never a boot that fails.
const jobFileOf = (dir: string): BackgroundJob | undefined => {
    try {
        const parsed: unknown = JSON.parse(readFileSync(join(dir, JOB_FILE), "utf8"));
        if (typeof parsed !== "object" || parsed === null) {
            return undefined;
        }
        const entry = parsed as Partial<BackgroundJob>;
        const { id, conversationId, command, session, startedAt } = entry;
        if (typeof id !== "string" || typeof conversationId !== "string" || typeof command !== "string" || typeof session !== "string" || typeof startedAt !== "number") {
            return undefined;
        }
        return { id, conversationId, command, dir, session, startedAt, turn: entry.turn ?? {} };
    } catch {
        return undefined;
    }
};

/**
 * Re-files the jobs a dead daemon left running, once at boot. They come back ALREADY adopted: a watch armed before the
 * restart is restored from its own journal, and arming a second one here would wake the conversation twice for one
 * job. What this restores is the fact the reaper needs — that these terminals hold work — which nothing else records.
 * Answers how many it took back.
 */
export const restoreBackgroundJobs = (now: number = Date.now()): number => {
    let restored = 0;
    for (const entry of readdirSync(tmpdir(), { withFileTypes: true }).filter((candidate) => candidate.isDirectory() && candidate.name.startsWith(JOB_DIR_PREFIX))) {
        const job = jobFileOf(join(tmpdir(), entry.name));
        if (job === undefined || jobs.has(job.id) || jobFinished(job) || now - job.startedAt > JOB_MAX_MS) {
            continue;
        }
        jobs.set(job.id, { job, adopted: true });
        restored += 1;
    }
    return restored;
};

/**
 * The conversation's jobs that were still running when its turn ended, marked adopted as they are handed out. Jobs that
 * finished inside the turn retire here: the turn already had their result from the Bash call itself.
 */
export const adoptableBackgroundJobs = (conversationId: string): BackgroundJob[] => {
    const ready: BackgroundJob[] = [];
    for (const [id, record] of jobs) {
        if (record.job.conversationId !== conversationId) {
            continue;
        }
        if (jobFinished(record.job)) {
            jobs.delete(id);
            continue;
        }
        if (record.adopted) {
            continue;
        }
        record.adopted = true;
        ready.push(record.job);
    }
    return ready;
};

/**
 * tmux sessions holding a job that is still running, for the reaper's terminal sweep. Prunes as it reads: a record is
 * only interesting while its command has not exited and its ceiling has not passed.
 */
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
