import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTurn } from "@intentic/sandbox-contract";
import { pino } from "pino";
import { afterEach, describe, expect, it } from "bun:test";
import { memoryWatchJournal } from "../verification/watch-journal.js";
import { startWatcherRuntime, type WatcherRuntime } from "../verification/watchers.js";
import { adoptBackgroundJobs, completionCheck, jobNote } from "./background-adoption.js";
import {
    type BackgroundJob,
    backgroundJobOf,
    backgroundJobSessions,
    jobCommandLine,
    jobHandle,
    jobLabel,
    JOB_MAX_MS,
    jobReport,
    jobStatusPath,
    noteJobNotice,
    noteJobShell,
    noteModelRequest,
    openBackgroundJob,
    restoreBackgroundJobs,
    settledBackgroundJobs,
    sweepJobEnds,
} from "./background-jobs.js";
import { jobProjection } from "./job-state.js";

// The fix for a job that used to die fifteen seconds after its turn: it is registered here while it runs, handed to a
// watch when the turn ends, and keeps its terminal off the reaper's list until it exits. Every conversation id in this
// file is its own, since the registry is module state shared with whatever else the suite runs.

const logger = pino({ level: "silent" });

const seedOf = (conversationId: string) => ({ conversationId, turn: {} });

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

const opened = (conversationId: string, command = "pnpm build", toolUseId?: string, description?: string): BackgroundJob => {
    const job = openBackgroundJob(seedOf(conversationId), {
        command,
        session: `agent-${conversationId}`,
        ...(toolUseId === undefined ? {} : { toolUseId }),
        ...(description === undefined ? {} : { description }),
    });
    if (job === undefined) {
        throw new Error("the job dir could not be minted");
    }
    dirs.push(job.dir);
    return job;
};

// A job dir as a dead daemon left it: on disk with its own `job.json`, and unknown to this process's registry. The
// prefix and the filename are the on-disk contract a restart reads back, so they are spelled here rather than
// imported.
const planted = (conversationId: string, file: Record<string, unknown> = {}): BackgroundJob => {
    const id = randomUUID();
    const dir = join(tmpdir(), `intentic-run-job-${id}`);
    mkdirSync(dir, { recursive: true });
    dirs.push(dir);
    const job: BackgroundJob = {
        id,
        conversationId,
        command: "pnpm build",
        label: "pnpm build",
        dir,
        session: `agent-${conversationId}`,
        startedAt: Date.now(),
        turn: {},
    };
    const { dir: _dir, ...onDisk } = job;
    writeFileSync(join(dir, "job.json"), JSON.stringify({ ...onDisk, ...file }));
    return job;
};

// What bin/tmux-run publishes when the command exits; existence alone is the completion signal.
const finish = (job: BackgroundJob, code = "0", output = "built\n"): void => {
    writeFileSync(`${job.dir}/out`, output);
    writeFileSync(jobStatusPath(job), `${code}\n`);
};

describe("background job registry", () => {
    it("holds a running job's terminal off the reaper and hands it out at settle exactly once", () => {
        const job = opened("conv-running");
        expect(backgroundJobSessions()).toContain(job.session);
        expect(settledBackgroundJobs("conv-running").running.map((entry) => entry.id)).toEqual([job.id]);
        // Second settle on the same conversation (a steer, a wake) must not arm a second watch for one job.
        expect(settledBackgroundJobs("conv-running")).toEqual({ running: [], unseen: [] });
        // Still running, so the terminal is still spared.
        expect(backgroundJobSessions()).toContain(job.session);
    });

    it("retires a job whose completion notice the model read, and reports nothing", () => {
        const job = opened("conv-read", "pnpm build", "tu-read");
        noteJobShell("tu-read", "bsh-read");
        finish(job);
        noteJobNotice("bsh-read");
        noteModelRequest("conv-read");
        expect(settledBackgroundJobs("conv-read")).toEqual({ running: [], unseen: [] });
        expect(backgroundJobSessions()).not.toContain(job.session);
    });

    it("hands out a job that finished after the model's last request as unseen", () => {
        const queued = opened("conv-unseen", "pnpm test", "tu-unseen");
        noteJobShell("tu-unseen", "bsh-unseen");
        noteModelRequest("conv-unseen");
        finish(queued);
        noteJobNotice("bsh-unseen");
        const silent = opened("conv-unseen", "pnpm lint");
        finish(silent);
        expect(
            settledBackgroundJobs("conv-unseen")
                .unseen.map((entry) => entry.id)
                .toSorted(),
        ).toEqual([queued.id, silent.id].toSorted());
        expect(settledBackgroundJobs("conv-unseen")).toEqual({ running: [], unseen: [] });
    });

    it("counts a notice as read only by a request of its own conversation", () => {
        const job = opened("conv-own", "pnpm build", "tu-own");
        noteJobShell("tu-own", "bsh-own");
        finish(job);
        noteJobNotice("bsh-own");
        noteModelRequest("conv-someone-else");
        expect(settledBackgroundJobs("conv-own").unseen.map((entry) => entry.id)).toEqual([job.id]);
    });

    it("retires a job that outran its ceiling, so a stopped conversation cannot pin a terminal forever", () => {
        const job = opened("conv-forever");
        expect(backgroundJobSessions(job.startedAt + JOB_MAX_MS - 1)).toContain(job.session);
        expect(backgroundJobSessions(job.startedAt + JOB_MAX_MS + 1)).not.toContain(job.session);
    });

    it("answers only for the conversation asked about", () => {
        const mine = opened("conv-mine");
        opened("conv-theirs");
        expect(settledBackgroundJobs("conv-mine").running.map((entry) => entry.id)).toEqual([mine.id]);
    });

    it("finds a job by the id the model was given, and hands that id back", () => {
        const job = opened("conv-named", "pnpm build", "tu-named");
        expect(jobHandle(job)).toBe(job.id);
        noteJobShell("tu-named", "bsh-named");
        expect(backgroundJobOf("conv-named", "bsh-named")?.id).toBe(job.id);
        expect(backgroundJobOf("conv-named", job.id)?.id).toBe(job.id);
        expect(backgroundJobOf("conv-other", "bsh-named")).toBeUndefined();
        expect(jobHandle(job)).toBe("bsh-named");
    });

    it("reports a job's exit code, its output tail and where the rest is", async () => {
        const job = opened("conv-report", "pnpm  build");
        expect(await jobReport(job)).toMatchObject({ running: true, exitCode: undefined, command: "pnpm build" });
        finish(job, "2", "error TS2345\n");
        expect(await jobReport(job)).toEqual({
            id: job.id,
            command: "pnpm build",
            exitCode: 2,
            running: false,
            outputTail: "error TS2345\n",
            outputFile: join(job.dir, "out"),
        });
    });

    it("takes a still-running job back after a restart, adopted exactly as its own file says", () => {
        // A dir with no entry in this process's registry is exactly what a container recreate leaves behind.
        const adopted = planted("conv-restart", { adopted: true });
        const never = planted("conv-restart");
        expect(backgroundJobSessions()).not.toContain(adopted.session);
        const restored = restoreBackgroundJobs().map((job) => job.id);
        expect(restored).toContain(adopted.id);
        expect(restored).toContain(never.id);
        expect(backgroundJobSessions()).toContain(adopted.session);
        // The adopted job's watch comes back from the watch journal; only the other is handed out.
        expect(settledBackgroundJobs("conv-restart").running.map((job) => job.id)).toEqual([never.id]);
    });

    it("writes the adoption and the model's id to the job's own file, for the next daemon to read", () => {
        const job = opened("conv-persist", "pnpm build", "tu-persist");
        noteJobShell("tu-persist", "bsh-persist");
        settledBackgroundJobs("conv-persist");
        expect(JSON.parse(readFileSync(join(job.dir, "job.json"), "utf8"))).toMatchObject({ id: job.id, shellId: "bsh-persist", adopted: true });
    });

    it("leaves a finished or expired job where it lies on a restart", () => {
        const done = planted("conv-restart-done");
        finish(done);
        const old = planted("conv-restart-old");
        restoreBackgroundJobs(old.startedAt + JOB_MAX_MS + 1);
        expect(backgroundJobSessions()).not.toContain(done.session);
        expect(backgroundJobSessions()).not.toContain(old.session);
    });

    it("ignores a dir that carries no readable job of its own, or one whose routing is not a routing", () => {
        const stray = join(tmpdir(), `intentic-run-job-${randomUUID()}`);
        mkdirSync(stray, { recursive: true });
        dirs.push(stray);
        writeFileSync(join(stray, "job.json"), "{ not json");
        const malformed = planted("conv-malformed", { turn: { agent: 42 } });
        expect(restoreBackgroundJobs().map((job) => job.id)).not.toContain(malformed.id);
    });

    it("names a job by the agent's description of the call, else by its command", () => {
        expect(jobLabel("  Typecheck the\n machine package ", "tsgo --noEmit")).toBe("Typecheck the machine package");
        expect(jobLabel(undefined, "pnpm   build")).toBe("pnpm build");
        expect(jobLabel("   ", "pnpm build")).toBe("pnpm build");
    });

    it("tells the card a job is running, then how it ended, and keeps the ending after the registry lets the job go", () => {
        const job = opened("conv-card", "pnpm build", undefined, "Build the app");
        expect(jobProjection.of("conv-card")).toEqual([{ id: job.id, label: "Build the app", session: job.session, startedAt: job.startedAt }]);
        finish(job, "2");
        sweepJobEnds();
        const [ending] = jobProjection.of("conv-card") ?? [];
        expect(ending).toMatchObject({ id: job.id, label: "Build the app", exitCode: 2 });
        expect(ending?.endedAt).toBeGreaterThanOrEqual(job.startedAt);
        settledBackgroundJobs("conv-card");
        expect(jobProjection.of("conv-card")).toEqual([ending!]);
    });

    it("writes down an ending the sweep never saw when the registry lets the job go", () => {
        const job = opened("conv-card-late");
        finish(job, "0");
        settledBackgroundJobs("conv-card-late");
        expect(jobProjection.of("conv-card-late")).toMatchObject([{ id: job.id, exitCode: 0 }]);
    });

    it("drops a job that outran its ceiling from the card without inventing an ending", () => {
        const job = opened("conv-card-forever");
        backgroundJobSessions(job.startedAt + JOB_MAX_MS + 1);
        expect(jobProjection.of("conv-card-forever")).toEqual([]);
    });

    it("folds a command to one readable line", () => {
        expect(jobCommandLine("  pnpm\n  build  ")).toBe("pnpm build");
        expect(jobCommandLine("x".repeat(200))).toHaveLength(120);
        expect(jobCommandLine("x".repeat(200)).endsWith("…")).toBe(true);
    });
});

// Delivery runs on a promise chain the adoption does not await; bounded, so a missing wake fails rather than hangs.
const delivered = async (count: () => number): Promise<void> => {
    const deadline = Date.now() + 2_000;
    while (count() === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
};

describe("background job adoption", () => {
    const checks: string[] = [];
    const started: (AgentTurn & { conversationId: string })[] = [];
    let stop: () => void = () => undefined;

    // Finished once the job's status file exists, as the real check reads it.
    const runtime = (): WatcherRuntime => ({
        logger,
        runCheck: (command) => {
            checks.push(command);
            const finished = dirs.some((dir) => command.includes(join(dir, "status")) && existsSync(join(dir, "status")));
            return Promise.resolve(finished ? { exitCode: 0, output: "exit 0\nbuilt" } : { exitCode: 1, output: "" });
        },
        steer: () => false,
        start: (turn) => {
            started.push(turn);
            return Promise.resolve(true);
        },
        sessionIdOf: () => undefined,
        journal: memoryWatchJournal(),
        envOf: () => Promise.resolve({}),
        conversationLive: () => true,
    });

    afterEach(() => {
        stop();
        checks.length = 0;
        started.length = 0;
    });

    it("arms a watch whose check reads the job's own status file, and whose note names the job", async () => {
        stop = startWatcherRuntime(runtime());
        const job = opened("conv-adopt", "pnpm turbo run test");
        expect(await adoptBackgroundJobs("conv-adopt", logger)).toBe(1);
        expect(checks).toEqual([completionCheck(job)]);
        expect(completionCheck(job)).toContain(jobStatusPath(job));
        expect(jobNote(job)).toBe(`Background job "pnpm turbo run test"`);
        expect(started).toEqual([]);
    });

    it("reports a job that finished unseen straight away", async () => {
        stop = startWatcherRuntime(runtime());
        const job = opened("conv-late", "pnpm test");
        finish(job);
        expect(await adoptBackgroundJobs("conv-late", logger)).toBe(1);
        await delivered(() => started.length);
        expect(started).toHaveLength(1);
        expect(started[0]?.prompt).toMatch(/^Watch fired/);
        expect(started[0]?.prompt).toContain(jobNote(job));
    });

    it("reports nothing for a conversation whose jobs all ended where the model read them", async () => {
        stop = startWatcherRuntime(runtime());
        const job = opened("conv-nothing", "pnpm build", "tu-nothing");
        noteJobShell("tu-nothing", "bsh-nothing");
        finish(job);
        noteJobNotice("bsh-nothing");
        noteModelRequest("conv-nothing");
        expect(await adoptBackgroundJobs("conv-nothing", logger)).toBe(0);
        expect(checks).toEqual([]);
    });

    it("marks a fetching job's report as outside content", async () => {
        stop = startWatcherRuntime(runtime());
        const job = opened("conv-fetch", "curl -s https://example.com/status");
        finish(job);
        await adoptBackgroundJobs("conv-fetch", logger);
        await delivered(() => started.length);
        expect(started[0]?.outsideWake).toBe("shell-fetch");
    });
});
