import { existsSync, type FSWatcher, statSync, watch } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import { undefinedIfMissing } from "@intentic/base/errors";
import type { ActivityStore } from "../../../activity/activity-store.js";
import type { ConversationActors } from "../../../conversations/actor/conversation-actors.js";
import { logsRoot } from "../../../seams/logs-root.js";
import { DAEMON_OWNER, ONE_SHOT_OWNER } from "../../../seams/workload-stamp.js";
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

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

const sized = (bytes: number | undefined): string => {
    if (bytes === undefined) {
        return "unknown";
    }
    return bytes >= GIB ? `${(bytes / GIB).toFixed(1)} GiB` : `${Math.round(bytes / MIB)} MiB`;
};

const KILLERS = {
    "netd-guard": "the sandbox's memory guard",
    "cgroup-oom": "the kernel, at the bounds of the workload cgroup every agent process runs in",
    "kernel-oom": "the kernel, for the whole machine",
} as const satisfies Record<MemoryKill["killer"], string>;

/** The kill in one sentence, as a job's ending and the conversation's notice say it. */
export const killSentence = (kill: MemoryKill): string =>
    `killed for memory: ${kill.comm} (pid ${String(kill.pid)}), peak RSS ${sized(kill.rssBytes)}, swap ${sized(kill.swapBytes)}, by ${KILLERS[kill.killer]}: ${kill.reason ?? "no reason was recorded"}`;

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
    const said = `${subject} was ${sentence}.`;
    // Into the live turn, between two tool calls, as the sandbox's words: a turn at rest is never started for it.
    steerTurn(deps.conversations, conversationId, { text: said, voice: "sandbox" });
    await deps.activity.append({ direction: "system", type: "memory.killed", conversationId, content: said, extra: { kill } });
};

export interface MemoryKillFollower {
    // Reads and tells whatever was appended since the last read, now: what a job's report waits on (job-report.ts).
    readonly settle: () => Promise<void>;
    readonly stop: () => void;
}

// Read whole lines only, from `offset`: the offset moves past the last newline read, so a line netd is still writing is
// read whole next time. A file shorter than the offset was cut, and is read again from its start.
const readLinesFrom = async (path: string, offset: number): Promise<{ readonly text: string; readonly next: number }> => {
    // A file not there yet (no kill since the sandbox was made) has nothing to read; any other failure is the pass's.
    const handle = await open(path, "r").catch(undefinedIfMissing);
    if (handle === undefined) {
        return { text: "", next: 0 };
    }
    try {
        const { size } = await handle.stat();
        const from = size < offset ? 0 : offset;
        const buffer = Buffer.alloc(size - from);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, from);
        const end = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
        return end < 0 ? { text: "", next: from } : { text: buffer.toString("utf8", 0, end + 1), next: from + end + 1 };
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
    let offset = existsSync(path) ? statSync(path).size : 0;
    let queue: Promise<void> = Promise.resolve();
    // The kills already told, the newest few hundred: the logs prune cuts a file past its cap to its newest lines, which
    // this then reads again from the start, and a kill is told once however often its line is read.
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
        const { text, next } = await readLinesFrom(path, offset);
        offset = next;
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
