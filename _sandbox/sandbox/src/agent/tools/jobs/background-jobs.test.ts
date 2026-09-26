import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pino } from "pino";
import { memoryWatchJournal } from "../../verification/watch-journal.js";
import { startWatcherRuntime, type WatcherRuntime } from "../../verification/watchers.js";
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
import { fakeTurns, memoryFleet } from "../../../testing.js";
import { awaitingWake } from "../../../conversations/actor/conversation-state.js";
import { turnCloser } from "../../run/placement/turn-close.js";

// One fleet's actors, which hold every record the registry under test files.
const actors = memoryFleet().conversations;

// The fix for a job that used to die fifteen seconds after its turn: it is registered here while it runs, handed to a
// watch when the turn ends, and keeps its terminal off the reaper's list until it exits. Every conversation id in this
// file is its own, since the doors file into the one registry the whole file shares.

const logger = pino({ level: "silent" });

const seedOf = (conversationId: string) => ({ conversationId, profile: {}, conversations: actors });

// What the conversation's card lists, as its actor holds it.
const listed = (conversationId: string) => actors.state(conversationId)?.jobs;

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
    ranIn(job);
    return job;
};

// What bin/tmux-run writes before it opens the pane; a job without it never ran.
const ranIn = (job: BackgroundJob): void => writeFileSync(join(job.dir, "cmd"), `${job.command}\n`);

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
        profile: {},
    };
    const { dir: _dir, profile, ...onDisk } = job;
    writeFileSync(join(dir, "job.json"), JSON.stringify({ ...onDisk, turn: profile, ...file }));
    ranIn(job);
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
        expect(backgroundJobSessions(actors)).toContain(job.session);
        expect(settledBackgroundJobs(actors, "conv-running").running.map((entry) => entry.id)).toEqual([job.id]);
        // Second settle on the same conversation (a steer, a wake) must not arm a second watch for one job.
        expect(settledBackgroundJobs(actors, "conv-running")).toEqual({ running: [], unseen: [] });
        // Still running, so the terminal is still spared.
        expect(backgroundJobSessions(actors)).toContain(job.session);
    });

    it("retires a job whose completion notice the model read, and reports nothing", () => {
        const job = opened("conv-read", "pnpm build", "tu-read");
        noteJobShell(actors, "tu-read", "bsh-read");
        finish(job);
        noteJobNotice(actors, "bsh-read");
        noteModelRequest(actors, "conv-read");
        expect(settledBackgroundJobs(actors, "conv-read")).toEqual({ running: [], unseen: [] });
        expect(backgroundJobSessions(actors)).not.toContain(job.session);
    });

    it("hands out a job that finished after the model's last request as unseen", () => {
        const queued = opened("conv-unseen", "pnpm test", "tu-unseen");
        noteJobShell(actors, "tu-unseen", "bsh-unseen");
        noteModelRequest(actors, "conv-unseen");
        finish(queued);
        noteJobNotice(actors, "bsh-unseen");
        const silent = opened("conv-unseen", "pnpm lint");
        finish(silent);
        expect(
            settledBackgroundJobs(actors, "conv-unseen")
                .unseen.map((entry) => entry.id)
                .toSorted(),
        ).toEqual([queued.id, silent.id].toSorted());
        expect(settledBackgroundJobs(actors, "conv-unseen")).toEqual({ running: [], unseen: [] });
    });

    it("counts a notice as read only by a request of its own conversation", () => {
        const job = opened("conv-own", "pnpm build", "tu-own");
        noteJobShell(actors, "tu-own", "bsh-own");
        finish(job);
        noteJobNotice(actors, "bsh-own");
        noteModelRequest(actors, "conv-someone-else");
        expect(settledBackgroundJobs(actors, "conv-own").unseen.map((entry) => entry.id)).toEqual([job.id]);
    });

    it("retires a job that outran its ceiling, so a stopped conversation cannot pin a terminal forever", () => {
        const job = opened("conv-forever");
        expect(backgroundJobSessions(actors, job.startedAt + JOB_MAX_MS - 1)).toContain(job.session);
        expect(backgroundJobSessions(actors, job.startedAt + JOB_MAX_MS + 1)).not.toContain(job.session);
    });

    it("answers only for the conversation asked about", () => {
        const mine = opened("conv-mine");
        opened("conv-theirs");
        expect(settledBackgroundJobs(actors, "conv-mine").running.map((entry) => entry.id)).toEqual([mine.id]);
    });

    it("finds a job by the id the model was given, and hands that id back", () => {
        const job = opened("conv-named", "pnpm build", "tu-named");
        expect(jobHandle(actors, job)).toBe(job.id);
        noteJobShell(actors, "tu-named", "bsh-named");
        expect(backgroundJobOf(actors, "conv-named", "bsh-named")?.id).toBe(job.id);
        expect(backgroundJobOf(actors, "conv-named", job.id)?.id).toBe(job.id);
        expect(backgroundJobOf(actors, "conv-other", "bsh-named")).toBeUndefined();
        expect(jobHandle(actors, job)).toBe("bsh-named");
    });

    it("reports a job's exit code, its output tail and where the rest is", async () => {
        const job = opened("conv-report", "pnpm  build");
        expect(await jobReport(actors, job)).toMatchObject({ running: true, exitCode: undefined, command: "pnpm build" });
        finish(job, "2", "error TS2345\n");
        expect(await jobReport(actors, job)).toEqual({
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
        expect(backgroundJobSessions(actors)).not.toContain(adopted.session);
        const restored = restoreBackgroundJobs(actors).map((job) => job.id);
        expect(restored).toContain(adopted.id);
        expect(restored).toContain(never.id);
        expect(backgroundJobSessions(actors)).toContain(adopted.session);
        // The adopted job's watch comes back from the watch journal; only the other is handed out.
        expect(settledBackgroundJobs(actors, "conv-restart").running.map((job) => job.id)).toEqual([never.id]);
    });

    it("writes the adoption and the model's id to the job's own file, for the next daemon to read", () => {
        const job = opened("conv-persist", "pnpm build", "tu-persist");
        noteJobShell(actors, "tu-persist", "bsh-persist");
        settledBackgroundJobs(actors, "conv-persist");
        expect(JSON.parse(readFileSync(join(job.dir, "job.json"), "utf8"))).toMatchObject({ id: job.id, shellId: "bsh-persist", adopted: true });
    });

    it("ends a job whose command never reached a terminal once its turn settles, and hands it out as unseen", async () => {
        const job = openBackgroundJob(seedOf("conv-never"), { command: "pnpm build", session: "agent-conv-never" });
        if (job === undefined) {
            throw new Error("the job dir could not be minted");
        }
        dirs.push(job.dir);
        expect(settledBackgroundJobs(actors, "conv-never")).toEqual({ running: [], unseen: [job] });
        expect(listed("conv-never")?.map((entry) => ({ id: entry.id, ended: entry.endedAt !== undefined, exitCode: entry.exitCode }))).toEqual([
            { id: job.id, ended: true, exitCode: undefined },
        ]);
        expect(await jobReport(actors, job)).toMatchObject({ running: false, exitCode: undefined });
        expect(backgroundJobSessions(actors)).not.toContain(job.session);
    });

    it("ends a restored job whose command never ran rather than taking it back", () => {
        const job = planted("conv-restart-never", { adopted: true });
        rmSync(join(job.dir, "cmd"));
        expect(restoreBackgroundJobs(actors).map((entry) => entry.id)).not.toContain(job.id);
        expect(readFileSync(jobStatusPath(job), "utf8")).toBe("never-ran\n");
    });

    it("leaves a finished or expired job where it lies on a restart", () => {
        const done = planted("conv-restart-done");
        finish(done);
        const old = planted("conv-restart-old");
        restoreBackgroundJobs(actors, old.startedAt + JOB_MAX_MS + 1);
        expect(backgroundJobSessions(actors)).not.toContain(done.session);
        expect(backgroundJobSessions(actors)).not.toContain(old.session);
    });

    it("ignores a dir that carries no readable job of its own, or one whose routing is not a routing", () => {
        const stray = join(tmpdir(), `intentic-run-job-${randomUUID()}`);
        mkdirSync(stray, { recursive: true });
        dirs.push(stray);
        writeFileSync(join(stray, "job.json"), "{ not json");
        const malformed = planted("conv-malformed", { turn: { agent: 42 } });
        expect(restoreBackgroundJobs(actors).map((job) => job.id)).not.toContain(malformed.id);
    });

    it("names a job by the agent's description of the call, else by its command", () => {
        expect(jobLabel("  Typecheck the\n machine package ", "tsgo --noEmit")).toBe("Typecheck the machine package");
        expect(jobLabel(undefined, "pnpm   build")).toBe("pnpm build");
        expect(jobLabel("   ", "pnpm build")).toBe("pnpm build");
    });

    it("tells the card a job is running, then how it ended, and keeps the ending after the registry lets the job go", () => {
        const job = opened("conv-card", "pnpm build", undefined, "Build the app");
        expect(listed("conv-card")).toEqual([{ id: job.id, label: "Build the app", session: job.session, startedAt: job.startedAt }]);
        finish(job, "2");
        sweepJobEnds(actors);
        const [ending] = listed("conv-card") ?? [];
        expect(ending).toMatchObject({ id: job.id, label: "Build the app", exitCode: 2 });
        expect(ending?.endedAt).toBeGreaterThanOrEqual(job.startedAt);
        settledBackgroundJobs(actors, "conv-card");
        expect(listed("conv-card")).toEqual([ending!]);
    });

    it("writes down an ending the sweep never saw when the registry lets the job go", () => {
        const job = opened("conv-card-late");
        finish(job, "0");
        settledBackgroundJobs(actors, "conv-card-late");
        expect(listed("conv-card-late")).toMatchObject([{ id: job.id, exitCode: 0 }]);
    });

    it("drops a job that outran its ceiling from the card without inventing an ending", () => {
        const job = opened("conv-card-forever");
        backgroundJobSessions(actors, job.startedAt + JOB_MAX_MS + 1);
        expect(listed("conv-card-forever")).toEqual([]);
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
    // The wake doors: no live turn to take a steer, so every wake opens one.
    const doors = fakeTurns();
    const started = doors.started;
    let stop: () => void = () => undefined;

    // Finished once the job's status file exists, as the real check reads it.
    const runtime = (): WatcherRuntime => ({
        logger,
        runCheck: (command) => {
            checks.push(command);
            const finished = dirs.some((dir) => command.includes(join(dir, "status")) && existsSync(join(dir, "status")));
            return Promise.resolve(finished ? { exitCode: 0, output: "exit 0\nbuilt" } : { exitCode: 1, output: "" });
        },
        turns: doors.turns,
        sessionIdOf: () => undefined,
        journal: memoryWatchJournal(),
        envOf: () => Promise.resolve({}),
        conversationLive: () => true,
        conversations: actors,
    });

    afterEach(() => {
        stop();
        checks.length = 0;
        started.length = 0;
    });

    it("arms a watch whose check reads the job's own status file, and whose note names the job", async () => {
        stop = startWatcherRuntime(runtime());
        const job = opened("conv-adopt", "pnpm turbo run test");
        expect(await adoptBackgroundJobs(actors, "conv-adopt", logger)).toBe(1);
        expect(checks).toEqual([completionCheck(job)]);
        expect(completionCheck(job)).toContain(jobStatusPath(job));
        expect(jobNote(job)).toBe(`Background job "pnpm turbo run test"`);
        expect(started).toEqual([]);
    });

    // The watch's own check is every 30s; a job's status file landing is what wakes, measured at 3–27s before.
    it("wakes the conversation the moment a watched job's status file lands, not at its next check", async () => {
        stop = startWatcherRuntime(runtime());
        const job = opened("conv-prompt", "pnpm test");
        expect(await adoptBackgroundJobs(actors, "conv-prompt", logger)).toBe(1);
        finish(job);
        await delivered(() => started.length);
        expect(started).toHaveLength(1);
        expect(checks).toEqual([completionCheck(job), completionCheck(job)]);
    });

    it("moves the card the moment the status file lands, without a sweep", async () => {
        const job = opened("conv-card-now");
        finish(job, "0");
        await delivered(() => (listed("conv-card-now") ?? []).filter((entry) => entry.endedAt !== undefined).length);
        expect(listed("conv-card-now")).toMatchObject([{ id: job.id, exitCode: 0 }]);
    });

    // The turn's close arms the wakes before its land asks whether anything still wakes the conversation: what it
    // answers is read from what the conversation then holds, and a wake already on its way, never predicted from jobs.
    describe("at the turn's close", () => {
        const close = (conversationId: string) => turnCloser({ conversations: actors, scanPorts: async () => [], logger }, conversationId, undefined);

        it("leaves a conversation whose job still runs awaiting the wake its watch will send", async () => {
            stop = startWatcherRuntime(runtime());
            opened("conv-close-running", "pnpm test");
            expect(await close("conv-close-running").armWakes()).toBe(true);
            expect(awaitingWake(actors.state("conv-close-running")!)).toBe(true);
        });

        it("counts a job that finished unseen, whose wake is already on its way", async () => {
            stop = startWatcherRuntime(runtime());
            finish(opened("conv-close-unseen", "pnpm test"));
            expect(await close("conv-close-unseen").armWakes()).toBe(true);
            await delivered(() => started.length);
            expect(started).toHaveLength(1);
        });

        it("awaits nothing once the model read how its job ended", async () => {
            stop = startWatcherRuntime(runtime());
            const read = opened("conv-close-read", "pnpm build", "tu-close-read");
            noteJobShell(actors, "tu-close-read", "bsh-close-read");
            finish(read);
            noteJobNotice(actors, "bsh-close-read");
            noteModelRequest(actors, "conv-close-read");
            expect(await close("conv-close-read").armWakes()).toBe(false);
            expect(awaitingWake(actors.state("conv-close-read")!)).toBe(false);
        });
    });

    it("reports a job that finished unseen straight away", async () => {
        stop = startWatcherRuntime(runtime());
        const job = opened("conv-late", "pnpm test");
        finish(job);
        expect(await adoptBackgroundJobs(actors, "conv-late", logger)).toBe(1);
        await delivered(() => started.length);
        expect(started).toHaveLength(1);
        expect(started[0]?.prompt).toMatch(/^Watch fired/);
        expect(started[0]?.prompt).toContain(jobNote(job));
    });

    it("reports nothing for a conversation whose jobs all ended where the model read them", async () => {
        stop = startWatcherRuntime(runtime());
        const job = opened("conv-nothing", "pnpm build", "tu-nothing");
        noteJobShell(actors, "tu-nothing", "bsh-nothing");
        finish(job);
        noteJobNotice(actors, "bsh-nothing");
        noteModelRequest(actors, "conv-nothing");
        expect(await adoptBackgroundJobs(actors, "conv-nothing", logger)).toBe(0);
        expect(checks).toEqual([]);
    });

    it("marks a fetching job's report as outside content", async () => {
        stop = startWatcherRuntime(runtime());
        const job = opened("conv-fetch", "curl -s https://example.com/status");
        finish(job);
        await adoptBackgroundJobs(actors, "conv-fetch", logger);
        await delivered(() => started.length);
        expect(started[0]?.outsideWake).toBe("shell-fetch");
    });
});
