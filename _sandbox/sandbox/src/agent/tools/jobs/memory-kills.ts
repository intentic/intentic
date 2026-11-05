import { closeSync, existsSync, type FSWatcher, fstatSync, openSync, readSync, watch } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import { undefinedIfMissing } from "@intentic/base/errors";
import type { ActivityStore } from "../../../activity/activity-store.js";
import type { ConversationActors } from "../../../conversations/actor/conversation-actors.js";
import { logsRoot } from "../../../seams/logs-root.js";
import { DAEMON_OWNER, ONE_SHOT_OWNER } from "../../../seams/workload-stamp.js";
import { killSentence } from "../../../system/resources/memory-kill-words.js";
import { MEMORY_KILLS_FILE, type MemoryKill, MemoryKillSchema, parseLines } from "../../../system/resources/memory-records.js";
import { recentJobProcess, recentJobRunner } from "../../../system/resources/process-scan.js";
import { steerTurn } from "../../checkpoints/agent-steering.js";
import { JOBS, type JobRecord } from "./background-jobs.js";
import { MEMORY_KILL_FILE, OUTPUT_FILE } from "./job-files.js";
import { jobRunnerPids } from "./job-processes.js";
import { appendRunFile, writeRunFile } from "./run-files.js";

/* A KILL FOR MEMORY, TOLD TO THE CONVERSATION WHOSE PROCESS IT WAS (2026-11-05). A background job's game client grew to
   17.6 GB and 33 GB of swap; when the machine's memory finally gave, five turns came back interrupted, and the
   conversation that started it learned nothing: its job ended on a bare exit 137, if anything noticed it end at all.
   Two things kill for memory inside the sandbox now, and both write the kill to memory-kills.jsonl: netd's memory guard
   (`netd-guard`, written by netd while the daemon's own loop may be frozen) and the kernel at the workload leaf's bounds
   (`cgroup-oom`, named by the daemon's sampler, system/resources/cgroup-oom.ts). This follows that file from where it
   stood at boot (what came before is the boot's post-mortem's, system/boot/restarts) and, for each kill:
   - finds the background job the process was part of: by the job id the scan tied it to (the OOM detector's lines carry
     it), else by what the daemon's scan last saw of that pid (netd's lines carry none, and the incident's game client had
     left its job's process group), else by its process group, which is the job's runner's pid for everything a job
     starts that keeps it (process-scan.ts says why), whether the runner is still running or the scan saw it lately;
   - marks that job's ending in its capture dir, so its report (`wait`, job-report.ts), the watch its end wakes
     (background-adoption.ts) and its output file say what killed it, instead of a bare 137;
   - tells the conversation: into its live turn, as the sandbox's own words between two tool calls, so the agent hears it
     while it can still act on it; and in Activity, filed under the conversation, either way. It never starts a turn: a
     conversation at rest hears it from its job's ending when that wakes it, or reads it in Activity. */

// The conversation an owner stamp names; the two reserved owners are the daemon's own work, nobody's to tell.
const conversationOf = (owner: string | undefined): string | undefined =>
    owner === undefined || owner === "" || owner === DAEMON_OWNER || owner === ONE_SHOT_OWNER ? undefined : owner;

type Actors = Pick<ConversationActors, "holdings" | "send" | "steer">;

export interface MemoryKillDeps {
    readonly historyRoot: string;
    readonly conversations: Actors;
    readonly activity: Pick<ActivityStore, "append">;
    readonly logger: Pick<Logger, "info" | "warn">;
    // A backstop for a change the watch on the logs directory missed.
    readonly pollMs?: number;
    // The pid leading each job dir's pane, and what the shared scan last saw of a runner and of a job's process, by pid:
    // injected by tests.
    readonly runnerPids?: (dirs: readonly string[]) => Promise<ReadonlyMap<string, number>>;
    readonly recentRunner?: (pid: number) => { readonly jobId: string; readonly dir: string } | undefined;
    readonly recentProcess?: (pid: number) => { readonly jobId: string; readonly dir: string } | undefined;
}

// The job a kill was in, as far as the daemon can tell: its record while the daemon still holds it, its capture dir
// either way.
interface KilledJob {
    readonly dir: string;
    readonly record: JobRecord | undefined;
}

const jobOfKill = async (deps: MemoryKillDeps, kill: MemoryKill): Promise<KilledJob | undefined> => {
    const jobs = deps.conversations.holdings(JOBS);
    const byId = kill.jobId === undefined ? undefined : jobs.get(kill.jobId);
    if (byId !== undefined) {
        return { dir: byId.job.dir, record: byId };
    }
    // Only netd's pid is the container's: a kernel line the OOM detector could not match to a scanned process keeps the
    // pid the VM gave it, which here may be anyone's. A job the daemon no longer holds (a restart since) is still found
    // by its dir, where the scan saw that pid in it.
    const scanned = kill.killer === "netd-guard" ? (deps.recentProcess ?? recentJobProcess)(kill.pid) : undefined;
    if (scanned !== undefined && (kill.jobId === undefined || kill.jobId === scanned.jobId)) {
        return { dir: scanned.dir, record: jobs.get(scanned.jobId) };
    }
    if (kill.pgid === undefined) {
        return undefined;
    }
    const held = jobs.entries().map(([, record]) => record);
    const panes = await (deps.runnerPids ?? jobRunnerPids)(held.map((record) => record.job.dir));
    const running = held.find((record) => panes.get(record.job.dir) === kill.pgid);
    if (running !== undefined) {
        return { dir: running.job.dir, record: running };
    }
    const seen = (deps.recentRunner ?? recentJobRunner)(kill.pgid);
    return seen === undefined ? undefined : { dir: seen.dir, record: jobs.get(seen.jobId) };
};

// Written once per job: the job's ending says the first kill that ended it, and its output file says it once.
const markJob = (dir: string, sentence: string): boolean => {
    if (existsSync(join(dir, MEMORY_KILL_FILE))) {
        return false;
    }
    try {
        writeRunFile(dir, MEMORY_KILL_FILE, `${sentence}\n`);
        appendRunFile(dir, OUTPUT_FILE, `\n--- intentic: ${sentence}\n`);
        return true;
    } catch {
        // allow(silent-catch): a capture dir the tmp sweep already took has no ending left to mark; the conversation is still told.
        return false;
    }
};

/** One kill: its job's ending marked, its conversation told. Never throws for a kill nobody can be told of. */
export const tellMemoryKill = async (deps: MemoryKillDeps, kill: MemoryKill): Promise<void> => {
    const job = await jobOfKill(deps, kill);
    const sentence = killSentence(kill);
    const marked = job === undefined ? false : markJob(job.dir, sentence);
    const conversationId = job?.record?.job.conversationId ?? conversationOf(kill.owner);
    deps.logger.info(
        { conversationId, job: job?.record?.job.id ?? kill.jobId, dir: job?.dir, marked, pid: kill.pid, comm: kill.comm, killer: kill.killer },
        "memory kill: told to the conversation whose process it was",
    );
    if (conversationId === undefined) {
        return;
    }
    const subject = job?.record === undefined ? "A process this conversation started" : `Background job "${job.record.job.label}" (${job.record.shellId ?? job.record.job.id})`;
    // The kill in the sentence every place tells one in (memory-kill-words.ts), after what it was to this conversation.
    const said = `${subject}: ${sentence}.`;
    // Into the live turn, between two tool calls, as the sandbox's words: a turn at rest is never started for it.
    steerTurn(deps.conversations, conversationId, { text: said, voice: "sandbox" });
    await deps.activity.append({ direction: "system", type: "memory.killed", conversationId, content: said, extra: { kill } });
};

export interface MemoryKillFollower {
    // Reads and tells whatever was appended since the last read, now: what a job's report waits on (job-report.ts).
    readonly settle: () => Promise<void>;
    readonly stop: () => void;
}

/* WHERE THE FOLLOWER HAS READ TO, AND KNOWING THE FILE IS STILL THE ONE IT READ. Whole lines only: the offset moves past
   the last newline read, so a line netd is still writing is read whole next time. Two things can pull the file out from
   under that offset between two passes: the logs prune cutting it to its newest lines in place (logs/log-files.ts,
   cutToTail, the same inode), and a writer moving it aside to `<file>.1` for a new one (netd rotates its pressure
   samples so). A cut file that has grown back past the old offset by the next pass looks untouched by its size alone,
   and reading on from the offset then starts mid-line in other lines, skipping kills. So a pass trusts the offset only
   where three things hold: the same inode, a size at least the offset, and the very bytes it last read still just
   before it (the last line read, `seal`, which also says a newline sits there). Otherwise it looks for that line in what
   the file now holds and reads on after it, else reads from the start; a kill read twice is told once (`told` below).
   Not the tail reader the boot and a runtime's death read the same file with (system/boot/restarts/memory-trail.ts
   readTrail): that one reads the newest bytes of a file once, this one follows a file on from where it last stopped. */

interface ReadMark {
    readonly offset: number;
    // Undefined while no file was there.
    readonly ino: number | undefined;
    // The last line read, ending at `offset`; empty at the file's start.
    readonly seal: Buffer;
}

const UNREAD: ReadMark = { offset: 0, ino: undefined, seal: Buffer.alloc(0) };

// A kill's line is well under this (its argv is cut to 300 characters); a longer one keeps its end, enough to know it by.
const SEAL_BYTES = 4096;
// How much of a file that is no longer the one read is searched for the last line read: more than the prune keeps of a
// file it cuts (a million bytes), less than the cap it cuts at, so a log storm never puts the whole of one in the heap.
const REREAD_BYTES = 4 * 1024 * 1024;

// The line of `bytes` that ends at `end`, from the newline before it (or its last SEAL_BYTES), copied off `bytes`.
const lineEndingAt = (bytes: Buffer, end: number): Buffer => {
    const before = end >= 2 ? bytes.lastIndexOf(0x0a, end - 2) : -1;
    return Buffer.from(bytes.subarray(Math.max(before + 1, end - SEAL_BYTES), end));
};

/** Where a follower starting now stands: the file's end as it is, and its last line. */
const markOfEnd = (path: string): ReadMark => {
    let fd: number;
    try {
        fd = openSync(path, "r");
    } catch (error) {
        // A file not there yet (no kill since the sandbox was made) is read from its start once it is; any other failure
        // is the start's, as it always was.
        undefinedIfMissing(error);
        return UNREAD;
    }
    try {
        const { size, ino } = fstatSync(fd);
        const length = Math.min(size, SEAL_BYTES);
        const tail = Buffer.alloc(length);
        const got = readSync(fd, tail, 0, length, size - length);
        return { offset: size, ino, seal: lineEndingAt(tail.subarray(0, got), got) };
    } finally {
        closeSync(fd);
    }
};

// Whether the bytes up to the mark are still the ones read: the same file, not shorter, and the last line read in place.
const intact = async (handle: FileHandle, mark: ReadMark, size: number, ino: number): Promise<boolean> => {
    if (mark.offset === 0) {
        return true;
    }
    if ((mark.ino !== undefined && ino !== mark.ino) || size < mark.offset) {
        return false;
    }
    const there = Buffer.alloc(mark.seal.length);
    const { bytesRead } = await handle.read(there, 0, there.length, mark.offset - mark.seal.length);
    return bytesRead === there.length && there.equals(mark.seal);
};

// Where to read on from in a file that is no longer the one read: after the last line read where it still holds it (a
// cut keeps the newest lines, so it does), else its start, or the first whole line of its newest REREAD_BYTES.
const refound = async (handle: FileHandle, mark: ReadMark, size: number): Promise<{ readonly from: number; readonly seal: Buffer }> => {
    const start = Math.max(0, size - REREAD_BYTES);
    const window = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(window, 0, window.length, start);
    const held = window.subarray(0, bytesRead);
    const at = mark.seal.length === 0 ? -1 : held.lastIndexOf(mark.seal);
    if (at >= 0) {
        return { from: start + at + mark.seal.length, seal: mark.seal };
    }
    return { from: start === 0 ? 0 : start + held.indexOf(0x0a) + 1, seal: Buffer.alloc(0) };
};

const readLinesFrom = async (path: string, mark: ReadMark): Promise<{ readonly text: string; readonly mark: ReadMark }> => {
    // A file gone (moved aside, removed) has nothing to read, and whatever next takes its name is read from its start;
    // any other failure is the pass's.
    const handle = await open(path, "r").catch(undefinedIfMissing);
    if (handle === undefined) {
        return { text: "", mark: UNREAD };
    }
    try {
        const { size, ino } = await handle.stat();
        const { from, seal } = (await intact(handle, mark, size, ino)) ? { from: mark.offset, seal: mark.seal } : await refound(handle, mark, size);
        const buffer = Buffer.alloc(size - from);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, from);
        const read = buffer.subarray(0, bytesRead);
        const end = read.lastIndexOf(0x0a);
        if (end < 0) {
            return { text: "", mark: { offset: from, ino, seal } };
        }
        return { text: read.toString("utf8", 0, end + 1), mark: { offset: from + end + 1, ino, seal: lineEndingAt(read, end + 1) } };
    } finally {
        await handle.close();
    }
};

let active: MemoryKillFollower | undefined;

const TOLD_KEPT = 500;

/** The running follower's settle; nothing to wait on where none runs (a local daemon, a test). */
export const settleMemoryKills = (): Promise<void> => active?.settle() ?? Promise.resolve();

/** Follows memory-kills.jsonl from its end as it stands now, telling each kill appended after. */
export const startMemoryKillFollower = (deps: MemoryKillDeps): MemoryKillFollower => {
    const dir = logsRoot(deps.historyRoot);
    const path = join(dir, MEMORY_KILLS_FILE);
    let mark = markOfEnd(path);
    let queue: Promise<void> = Promise.resolve();
    // The kills already told, the newest few hundred: a file cut or replaced under the follower may be read again from
    // its start (readLinesFrom), and a kill is told once however often its line is read.
    const told: string[] = [];
    const fresh = (kill: MemoryKill): boolean => {
        const key = `${String(kill.at)}:${String(kill.pid)}:${kill.killer}`;
        if (told.includes(key)) {
            return false;
        }
        told.push(key);
        told.splice(0, Math.max(0, told.length - TOLD_KEPT));
        return true;
    };
    const pass = async (): Promise<void> => {
        const read = await readLinesFrom(path, mark);
        mark = read.mark;
        const { text } = read;
        for (const kill of parseLines(text, MemoryKillSchema).filter(fresh)) {
            await tellMemoryKill(deps, kill).catch((error: Error) => {
                deps.logger.warn({ err: error, pid: kill.pid, comm: kill.comm }, "memory kill: could not be told to its conversation");
            });
        }
    };
    // One pass at a time, in order, so no line is told twice.
    const settle = (): Promise<void> => {
        queue = queue.then(pass, pass).catch((error: Error) => {
            deps.logger.warn({ err: error, path }, "memory kill: the kills file could not be read");
        });
        return queue;
    };
    let watcher: FSWatcher | undefined;
    try {
        watcher = watch(dir, { persistent: false }, (_event, name) => {
            if (name === MEMORY_KILLS_FILE) {
                void settle();
            }
        });
        // allow(silent-catch): a watch that breaks leaves the poll below, which reads the same lines a few seconds later.
        watcher.on("error", () => undefined);
    } catch {
        // allow(silent-catch): a logs directory that cannot be watched (not made yet) leaves the poll below.
        watcher = undefined;
    }
    const timer = setInterval(() => void settle(), deps.pollMs ?? 5_000);
    timer.unref();
    const follower: MemoryKillFollower = {
        settle,
        stop: () => {
            clearInterval(timer);
            watcher?.close();
            if (active === follower) {
                active = undefined;
            }
        },
    };
    active = follower;
    return follower;
};
