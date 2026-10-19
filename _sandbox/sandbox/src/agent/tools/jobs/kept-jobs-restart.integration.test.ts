import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryFleet } from "../../../conversations/registry/agents-registry.testing.js";
import { killStaleManagedSessions } from "../../../processes/managed-processes.js";
import {
    type BackgroundJob,
    backgroundJobSessions,
    JOB_MAX_MS,
    jobStatusPath,
    keepBackgroundJob,
    keptJobDirs,
    openBackgroundJob,
    restorableJobSessions,
    restoreBackgroundJobs,
    settledBackgroundJobs,
} from "./background-jobs.js";
import { reportLostKeptJobs } from "./kept-job-records.js";

// A restart between the agent's `keep` and its turn's end used to lose the keep (it lived only in memory), so the boot
// sweep killed the kept dev server. Each test builds the state with one fleet, drops it, and runs the boot path's own
// functions against a fresh fleet over the same temp dirs.

const roots: string[] = [];
const temp = (prefix: string): string => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    roots.push(dir);
    return dir;
};
afterEach(() => {
    for (const dir of roots.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

interface Daemon {
    readonly actors: ReturnType<typeof memoryFleet>["conversations"];
}

const opened = (daemon: Daemon, tmp: string, historyRoot: string, conversationId: string, command = "pnpm dev"): BackgroundJob => {
    const job = openBackgroundJob({ conversationId, profile: {}, conversations: daemon.actors, tmp, historyRoot }, { command, session: `agent-${conversationId}` });
    if (job === undefined) {
        throw new Error("the job dir could not be minted");
    }
    // What bin/tmux-run writes before it opens the pane; a job without it never ran.
    writeFileSync(join(job.dir, "cmd"), `${command}\n`);
    return job;
};

const freshDaemon = (): Daemon => ({ actors: memoryFleet().conversations });

// A /proc with one process: the pane runner tmux-run starts for `dir`, which is how a still-running job is told apart.
const procWithRunner = (dir: string): string => {
    const proc = temp("kept-proc-");
    mkdirSync(join(proc, "4242"));
    writeFileSync(join(proc, "4242", "cmdline"), `bash\0${join(dir, "runner")}\0`);
    writeFileSync(join(proc, "4242", "stat"), "4242 (bash) S 1 4242 4242");
    return proc;
};

describe("a kept job across a restart", () => {
    it("writes the keep to job.json, so the boot sweep spares it and the restored job is not turned into a watch", () => {
        const tmp = temp("kept-tmp-");
        const history = temp("kept-history-");
        const before = freshDaemon();
        const job = opened(before, tmp, history, "conv-kept-restart");
        expect(keepBackgroundJob(before.actors, "conv-kept-restart", job.id, "dev server for the person")).toBe("kept");
        expect(JSON.parse(readFileSync(join(job.dir, "job.json"), "utf8"))).toMatchObject({ id: job.id, kept: "dev server for the person" });

        // The daemon restarts before the turn's ending hands the job over: nothing in memory survives.
        const after = freshDaemon();
        expect(keptJobDirs(tmp)).toContain(job.dir);
        expect(restorableJobSessions(tmp)).toContain(job.session);
        expect(restoreBackgroundJobs(after.actors, Date.now(), tmp).map((entry) => entry.id)).toEqual([job.id]);
        expect(backgroundJobSessions(after.actors)).toContain(job.session);
        // Adoption at boot settles unjudged jobs into completion watches; a kept one waits for its resumed turn instead.
        expect(settledBackgroundJobs(after.actors, "conv-kept-restart").running).toEqual([]);
        // Kept means the person's: the six-hour ceiling does not forget it.
        expect(restorableJobSessions(tmp, job.startedAt + JOB_MAX_MS + 1)).toContain(job.session);
    });

    it("spares every unfinished recorded job's session at boot, and only those", () => {
        const tmp = temp("kept-tmp-");
        const history = temp("kept-history-");
        const before = freshDaemon();
        const building = opened(before, tmp, history, "conv-restart-build", "pnpm build");
        const done = opened(before, tmp, history, "conv-restart-done", "pnpm test");
        writeFileSync(jobStatusPath(done), "0\n");
        const sessions = restorableJobSessions(tmp);
        expect(sessions).toContain(building.session);
        expect(sessions).not.toContain(done.session);
        expect(restorableJobSessions(tmp, building.startedAt + JOB_MAX_MS + 1)).not.toContain(building.session);
        expect(restoreBackgroundJobs(freshDaemon().actors, Date.now(), tmp).map((entry) => entry.id)).toEqual([building.id]);
    });

    it("tells the conversation a kept job was lost when the container's /tmp went with it, once", async () => {
        const tmp = temp("kept-tmp-");
        const history = temp("kept-history-");
        const before = freshDaemon();
        const job = opened(before, tmp, history, "conv-kept-lost");
        keepBackgroundJob(before.actors, "conv-kept-lost", job.id, "dev server");
        expect(readdirSync(join(history, "kept-jobs"))).toEqual([`${job.id}.json`]);

        // A container recreate: /tmp and every process are gone, /history stays.
        rmSync(job.dir, { recursive: true, force: true });
        const appended: unknown[] = [];
        const activity = { append: async (entry: unknown) => void appended.push(entry) };
        await reportLostKeptJobs(history, activity, temp("kept-proc-"));
        expect(appended).toEqual([expect.objectContaining({ type: "job.lost", conversationId: "conv-kept-lost", content: expect.stringContaining("pnpm dev") })]);
        expect(readdirSync(join(history, "kept-jobs"))).toEqual([]);
        await reportLostKeptJobs(history, activity, temp("kept-proc-"));
        expect(appended).toHaveLength(1);
    });

    it("keeps the receipt of a kept job still running, and retires one that ended on its own without a report", async () => {
        const tmp = temp("kept-tmp-");
        const history = temp("kept-history-");
        const before = freshDaemon();
        const live = opened(before, tmp, history, "conv-kept-live");
        const ended = opened(before, tmp, history, "conv-kept-ended");
        keepBackgroundJob(before.actors, "conv-kept-live", live.id, "dev server");
        keepBackgroundJob(before.actors, "conv-kept-ended", ended.id, "dev server");
        writeFileSync(jobStatusPath(ended), "0\n");
        const appended: unknown[] = [];
        await reportLostKeptJobs(history, { append: async (entry: unknown) => void appended.push(entry) }, procWithRunner(live.dir));
        expect(appended).toEqual([]);
        expect(readdirSync(join(history, "kept-jobs"))).toEqual([`${live.id}.json`]);
    });

    // The boot sweep itself, against a tmux server of the test's own (its own socket dir), never the machine's.
    it("leaves a kept job's tmux session alive through the real boot sweep and kills only the orphan", async () => {
        const tmp = temp("kept-tmp-");
        const history = temp("kept-history-");
        const socketDir = temp("kept-tmux-");
        const saved = { TMUX: process.env["TMUX"], TMUX_TMPDIR: process.env["TMUX_TMPDIR"] };
        delete process.env["TMUX"];
        process.env["TMUX_TMPDIR"] = socketDir;
        const tmux = (...args: string[]): string => execFileSync("tmux", args, { env: process.env, encoding: "utf8" });
        try {
            const before = freshDaemon();
            const job = opened(before, tmp, history, "conv-kept-sweep");
            keepBackgroundJob(before.actors, "conv-kept-sweep", job.id, "dev server");
            tmux("new-session", "-d", "-s", job.session, "sleep 60");
            tmux("new-session", "-d", "-s", "agent-orphan", "sleep 60");

            await killStaleManagedSessions(restorableJobSessions(tmp));
            const alive = tmux("list-sessions", "-F", "#{session_name}").split("\n");
            expect(alive).toContain(job.session);
            expect(alive).not.toContain("agent-orphan");
        } finally {
            try {
                tmux("kill-server");
            } catch {
                // allow(silent-catch): a server with no sessions left has already exited, which is the state this wants.
            }
            for (const [name, value] of Object.entries(saved)) {
                if (value === undefined) {
                    delete process.env[name];
                } else {
                    process.env[name] = value;
                }
            }
        }
    });
});
