import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pino } from "pino";
import { afterEach, describe, expect, it } from "bun:test";
import { memoryWatchJournal, type WatchJournal } from "../verification/watch-journal.js";
import { startWatcherRuntime, type WatcherRuntime } from "../verification/watchers.js";
import { adoptBackgroundJobs, completionCheck, jobNote } from "./background-adoption.js";
import {
    adoptableBackgroundJobs,
    type BackgroundJob,
    backgroundJobSessions,
    jobCommandLine,
    JOB_MAX_MS,
    jobStatusPath,
    openBackgroundJob,
    restoreBackgroundJobs,
} from "./background-jobs.js";

// The fix for a job that used to die fifteen seconds after its turn: it is registered here while it runs, handed to a
// watch when the turn ends, and keeps its terminal off the reaper's list until it exits. Every conversation id in this
// file is its own, since the registry is module state shared with whatever else the suite runs.

const logger = pino({ level: "silent" });

const seedOf = (conversationId: string) => ({ conversationId, turn: {} });

const opened = (conversationId: string, command = "pnpm build", session = `agent-${conversationId}`): BackgroundJob => {
    const job = openBackgroundJob(seedOf(conversationId), { command, session });
    if (job === undefined) {
        throw new Error("the job dir could not be minted");
    }
    dirs.push(job.dir);
    return job;
};

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

// A job dir as a dead daemon left it: on disk with its own `job.json`, and unknown to this process's registry. The
// prefix and the filename are the on-disk contract a restart reads back, so they are spelled here rather than
// imported.
const planted = (conversationId: string, command = "pnpm build"): BackgroundJob => {
    const id = randomUUID();
    const dir = join(tmpdir(), `intentic-run-job-${id}`);
    mkdirSync(dir, { recursive: true });
    dirs.push(dir);
    const job: BackgroundJob = { id, conversationId, command, dir, session: `agent-${conversationId}`, startedAt: Date.now(), turn: {} };
    writeFileSync(join(dir, "job.json"), JSON.stringify(job));
    return job;
};

// What bin/tmux-run publishes when the command exits; existence alone is the completion signal.
const finish = (job: BackgroundJob, code = "0", output = "built\n"): void => {
    writeFileSync(`${job.dir}/out`, output);
    writeFileSync(jobStatusPath(job), `${code}\n`);
};

describe("background job registry", () => {
    it("holds a running job's terminal off the reaper and offers it for adoption exactly once", () => {
        const job = opened("conv-running");
        expect(backgroundJobSessions()).toContain(job.session);
        expect(adoptableBackgroundJobs("conv-running").map((entry) => entry.id)).toEqual([job.id]);
        // Second settle on the same conversation (a steer, a wake) must not arm a second watch for one job.
        expect(adoptableBackgroundJobs("conv-running")).toEqual([]);
        // Still running, so the terminal is still spared.
        expect(backgroundJobSessions()).toContain(job.session);
    });

    it("retires a job that finished inside its turn, unadopted and no longer holding its terminal", () => {
        const job = opened("conv-finished");
        finish(job);
        expect(adoptableBackgroundJobs("conv-finished")).toEqual([]);
        expect(backgroundJobSessions()).not.toContain(job.session);
    });

    it("retires a job that outran its ceiling, so a stopped conversation cannot pin a terminal forever", () => {
        const job = opened("conv-forever");
        expect(backgroundJobSessions(job.startedAt + JOB_MAX_MS - 1)).toContain(job.session);
        expect(backgroundJobSessions(job.startedAt + JOB_MAX_MS + 1)).not.toContain(job.session);
    });

    it("answers only for the conversation asked about", () => {
        const mine = opened("conv-mine");
        opened("conv-theirs");
        expect(adoptableBackgroundJobs("conv-mine").map((entry) => entry.id)).toEqual([mine.id]);
    });

    it("takes a still-running job back after a restart, already adopted, so the reaper still spares its terminal", () => {
        // A dir with no entry in this process's registry is exactly what a container recreate leaves behind.
        const job = planted("conv-restart");
        expect(backgroundJobSessions()).not.toContain(job.session);
        expect(restoreBackgroundJobs()).toBeGreaterThanOrEqual(1);
        expect(backgroundJobSessions()).toContain(job.session);
        // Adopted on the way back: its watch is restored from the watch journal, and a second would wake it twice.
        expect(adoptableBackgroundJobs("conv-restart")).toEqual([]);
    });

    it("leaves a finished or expired job where it lies on a restart", () => {
        const done = planted("conv-restart-done");
        finish(done);
        const old = planted("conv-restart-old");
        restoreBackgroundJobs(old.startedAt + JOB_MAX_MS + 1);
        expect(backgroundJobSessions()).not.toContain(done.session);
        expect(backgroundJobSessions()).not.toContain(old.session);
    });

    it("ignores a dir that carries no readable job of its own", () => {
        const stray = join(tmpdir(), `intentic-run-job-${randomUUID()}`);
        mkdirSync(stray, { recursive: true });
        dirs.push(stray);
        writeFileSync(join(stray, "job.json"), "{ not json");
        expect(() => restoreBackgroundJobs()).not.toThrow();
    });

    it("folds a command to one readable line", () => {
        expect(jobCommandLine("  pnpm\n  build  ")).toBe("pnpm build");
        expect(jobCommandLine("x".repeat(200))).toHaveLength(120);
        expect(jobCommandLine("x".repeat(200)).endsWith("…")).toBe(true);
    });
});

describe("background job adoption", () => {
    const armed: { command: string; note: string }[] = [];
    let stop: () => void = () => undefined;

    const runtime = (): WatcherRuntime => {
        const journal: WatchJournal = memoryWatchJournal();
        return {
            logger,
            runCheck: (command) => {
                armed.push({ command, note: "" });
                // Non-zero: the job has not finished, which is what makes armWatcher arm rather than answer met.
                return Promise.resolve({ exitCode: 1, output: "" });
            },
            steer: () => false,
            start: () => Promise.resolve(true),
            sessionIdOf: () => undefined,
            journal,
            envOf: () => Promise.resolve({}),
            conversationLive: () => true,
            treeLive: () => Promise.resolve(true),
        };
    };

    afterEach(() => {
        stop();
        armed.length = 0;
    });

    it("arms a watch whose check reads the job's own status file, and whose note names the command", async () => {
        stop = startWatcherRuntime(runtime());
        const job = opened("conv-adopt", "pnpm turbo run test");
        expect(await adoptBackgroundJobs("conv-adopt", logger)).toBe(1);
        expect(armed).toHaveLength(1);
        expect(armed[0]?.command).toBe(completionCheck(job));
        expect(completionCheck(job)).toContain(jobStatusPath(job));
        expect(jobNote(job)).toBe("background job left running when the turn ended: `pnpm turbo run test`");
    });

    it("arms nothing for a conversation whose jobs all finished", async () => {
        stop = startWatcherRuntime(runtime());
        finish(opened("conv-nothing"));
        expect(await adoptBackgroundJobs("conv-nothing", logger)).toBe(0);
        expect(armed).toEqual([]);
    });
});
