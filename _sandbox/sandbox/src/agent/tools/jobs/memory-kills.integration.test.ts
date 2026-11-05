import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryFleet } from "../../../conversations/registry/agents-registry.testing.js";
import { MEMORY_KILLS_FILE, type MemoryKill } from "../../../system/resources/memory-records.js";
import { completionCheck } from "./background-adoption.js";
import { type BackgroundJob, openBackgroundJob } from "./background-jobs.js";
import { MEMORY_KILL_FILE, OUTPUT_FILE, STATUS_FILE } from "./job-files.js";
import { jobReport } from "./job-report.js";
import { killSentence, type MemoryKillDeps, startMemoryKillFollower, tellMemoryKill } from "./memory-kills.js";

/* 2026-11-05: a background job's game client was killed for memory, and the conversation that started it learned
   nothing; its job ended on a bare 137. Each kill here is told the way netd's guard or the daemon's OOM detector would
   write it, and what reaches the job's ending and the conversation is read back. */

const GIB = 1024 ** 3;
const actors = memoryFleet().conversations;
const ROOT = mkdtempSync(join(tmpdir(), "memory-kills-test-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const opened = (conversationId: string, command = "./integra --headless"): BackgroundJob => {
    const job = openBackgroundJob({ conversationId, profile: {}, conversations: actors, tmp: ROOT }, { command, session: `agent-${conversationId}`, description: "game client" });
    if (job === undefined) {
        throw new Error("the job dir could not be minted");
    }
    writeFileSync(join(job.dir, OUTPUT_FILE), "loading assets\n");
    return job;
};

const end = (job: BackgroundJob, code: number): void => writeFileSync(join(job.dir, STATUS_FILE), `${String(code)}\n`);

const kill = (fields: Partial<MemoryKill> = {}): MemoryKill => ({
    at: 1_762_340_000_000,
    killer: "cgroup-oom",
    pid: 502,
    comm: "integra",
    rssBytes: 17.6 * GIB,
    swapBytes: 3 * GIB,
    reason: "the workload cgroup every agent process runs in reached its bounds (memory.max 14.5 GiB, swap 4.0 GiB), and the kernel killed the process it scored worst",
    ...fields,
});

// What the conversation was told: words into its live turn, entries in Activity.
const listening = (options: { readonly live?: boolean } = {}) => {
    const steered: { conversationId: string; text: string }[] = [];
    const activity: unknown[] = [];
    const deps: MemoryKillDeps = {
        historyRoot: mkdtempSync(join(ROOT, "history-")),
        conversations: {
            holdings: actors.holdings,
            send: actors.send,
            steer: (conversationId, text) => {
                steered.push({ conversationId, text });
                return options.live === true;
            },
        },
        activity: { append: async (event) => void activity.push(event) },
        logger: { info: () => {}, warn: () => {} },
        runnerPids: async () => new Map(),
        recentRunner: () => undefined,
        recentProcess: () => undefined,
    };
    return { deps, steered, activity };
};

test("a kill is one sentence: what, its pid, its peak and its swap, by whom, and why", () => {
    expect(killSentence(kill())).toBe(
        "killed for memory: integra (pid 502), peak RSS 17.6 GiB, swap 3.0 GiB, by the kernel, at the bounds of the workload cgroup every agent process runs in: the workload cgroup every agent process runs in reached its bounds (memory.max 14.5 GiB, swap 4.0 GiB), and the kernel killed the process it scored worst",
    );
    expect(killSentence(kill({ killer: "netd-guard", swapBytes: undefined, rssBytes: 300 * 1024 ** 2, reason: undefined }))).toBe(
        "killed for memory: integra (pid 502), peak RSS 300 MiB, swap unknown, by the sandbox's memory guard: no reason was recorded",
    );
});

describe("telling a kill", () => {
    test("the job the scan tied it to has its ending marked, and its conversation's live turn and Activity are told", async () => {
        const job = opened("conv-kill-job");
        const { deps, steered, activity } = listening({ live: true });
        await tellMemoryKill(deps, kill({ jobId: job.id, owner: "conv-kill-job" }));
        const sentence = killSentence(kill());
        expect(readFileSync(join(job.dir, MEMORY_KILL_FILE), "utf8")).toBe(`${sentence}\n`);
        expect(readFileSync(join(job.dir, OUTPUT_FILE), "utf8")).toBe(`loading assets\n\n--- intentic: ${sentence}\n`);
        const said = `Background job "game client" (${job.id}) was ${sentence}.`;
        expect(steered).toEqual([{ conversationId: "conv-kill-job", text: said }]);
        expect(activity).toEqual([{ direction: "system", type: "memory.killed", conversationId: "conv-kill-job", content: said, extra: { kill: expect.objectContaining({ pid: 502 }) } }]);
    });

    test("netd's kill names only a process group, which is the job's runner while it still runs", async () => {
        const job = opened("conv-kill-group");
        const { deps } = listening();
        await tellMemoryKill({ ...deps, runnerPids: async (dirs) => new Map(dirs.filter((dir) => dir === job.dir).map((dir) => [dir, 4_242])) }, kill({ killer: "netd-guard", pgid: 4_242 }));
        expect(existsSync(join(job.dir, MEMORY_KILL_FILE))).toBe(true);
    });

    test("netd's kill of a process that left its job's group is found by what the scan last saw of that pid", async () => {
        const job = opened("conv-kill-own-group");
        const { deps, activity } = listening();
        // The incident's game client: its own process group (502), so the group names no runner.
        const recentProcess = (pid: number) => (pid === 502 ? { jobId: job.id, dir: job.dir } : undefined);
        await tellMemoryKill({ ...deps, recentProcess }, kill({ killer: "netd-guard", pgid: 502, owner: "conv-kill-own-group" }));
        expect(existsSync(join(job.dir, MEMORY_KILL_FILE))).toBe(true);
        expect(activity).toEqual([expect.objectContaining({ conversationId: "conv-kill-own-group", content: expect.stringContaining('Background job "game client"') })]);
        // A pid the scan last saw in another job than the one the kill names is a reused pid: that job is not marked.
        const other = opened("conv-kill-own-group");
        await tellMemoryKill({ ...deps, recentProcess: () => ({ jobId: other.id, dir: other.dir }) }, kill({ killer: "netd-guard", jobId: "a-job-long-gone" }));
        expect(existsSync(join(other.dir, MEMORY_KILL_FILE))).toBe(false);
        // Nor is a kernel line's pid, which is the VM's and may be any container process's.
        await tellMemoryKill({ ...deps, recentProcess: () => ({ jobId: other.id, dir: other.dir }) }, kill({ killer: "cgroup-oom" }));
        expect(existsSync(join(other.dir, MEMORY_KILL_FILE))).toBe(false);
    });

    test("a runner already gone is found by what the scan last saw of it", async () => {
        const job = opened("conv-kill-seen");
        const { deps, activity } = listening();
        await tellMemoryKill({ ...deps, recentRunner: (pid) => (pid === 77 ? { jobId: job.id, dir: job.dir } : undefined) }, kill({ pgid: 77, owner: "someone-else" }));
        expect(existsSync(join(job.dir, MEMORY_KILL_FILE))).toBe(true);
        // The job's conversation is told, whatever the stamp said.
        expect(activity).toEqual([expect.objectContaining({ conversationId: "conv-kill-seen" })]);
    });

    test("a process in no job is told to the conversation its stamp names; a turn at rest is never started for it", async () => {
        const { deps, steered, activity } = listening();
        await tellMemoryKill(deps, kill({ owner: "conv-kill-loose" }));
        expect(steered).toHaveLength(1);
        expect(activity).toEqual([expect.objectContaining({ conversationId: "conv-kill-loose", content: `A process this conversation started was ${killSentence(kill())}.` })]);
    });

    test("the daemon's own work and unstamped work have nobody to tell, and a job is marked once", async () => {
        const job = opened("conv-kill-once");
        const { deps, steered, activity } = listening();
        await tellMemoryKill(deps, kill({ owner: "daemon" }));
        await tellMemoryKill(deps, kill({ owner: undefined }));
        expect([...steered, ...activity]).toEqual([]);
        await tellMemoryKill(deps, kill({ jobId: job.id }));
        await tellMemoryKill(deps, kill({ jobId: job.id, comm: "second" }));
        expect(readFileSync(join(job.dir, OUTPUT_FILE), "utf8").match(/--- intentic: killed for memory/gu)).toHaveLength(1);
    });
});

describe("following the kills file", () => {
    const appendKill = (historyRoot: string, line: string): void => {
        mkdirSync(join(historyRoot, "logs"), { recursive: true });
        appendFileSync(join(historyRoot, "logs", MEMORY_KILLS_FILE), line);
    };

    test("tells what is appended after it starts, once, and a line still being written only once it is whole", async () => {
        const { deps, activity } = listening();
        appendKill(deps.historyRoot, `${JSON.stringify(kill({ owner: "conv-before-boot" }))}\n`);
        const follower = startMemoryKillFollower({ ...deps, pollMs: 60_000 });
        try {
            await follower.settle();
            // What came before is the boot's post-mortem's.
            expect(activity).toEqual([]);
            const line = JSON.stringify(kill({ owner: "conv-after-boot" }));
            appendKill(deps.historyRoot, line.slice(0, 20));
            await follower.settle();
            expect(activity).toEqual([]);
            appendKill(deps.historyRoot, `${line.slice(20)}\n{torn\n`);
            await follower.settle();
            await follower.settle();
            expect(activity).toEqual([expect.objectContaining({ conversationId: "conv-after-boot" })]);
        } finally {
            follower.stop();
        }
    });

    test("a file the logs prune cut to its newest lines is read again from its start, and nothing in it is told twice", async () => {
        const { deps, activity } = listening();
        const follower = startMemoryKillFollower({ ...deps, pollMs: 60_000 });
        try {
            const told = `${JSON.stringify(kill({ owner: "conv-cut", at: 1 }))}\n`;
            appendKill(deps.historyRoot, `${"x".repeat(4_000)}\n${told}`);
            await follower.settle();
            expect(activity).toHaveLength(1);
            writeFileSync(join(deps.historyRoot, "logs", MEMORY_KILLS_FILE), `${told}${JSON.stringify(kill({ owner: "conv-cut", at: 2 }))}\n`);
            await follower.settle();
            expect(activity).toHaveLength(2);
        } finally {
            follower.stop();
        }
    });

    test("a job's report waits a moment on a 137 for its kill to be told, and says what killed it", async () => {
        const job = opened("conv-kill-report");
        const { deps } = listening();
        const follower = startMemoryKillFollower({ ...deps, pollMs: 60_000 });
        try {
            end(job, 137);
            appendKill(deps.historyRoot, `${JSON.stringify(kill({ jobId: job.id, owner: "conv-kill-report" }))}\n`);
            const report = await jobReport(actors, job);
            expect(report.exitCode).toBe(137);
            expect(report.killedForMemory).toBe(killSentence(kill()));
        } finally {
            follower.stop();
        }
    });
});

test("a report of an ordinary exit carries no kill and waits on nothing", async () => {
    const job = opened("conv-kill-none");
    end(job, 1);
    const started = Date.now();
    expect((await jobReport(actors, job)).killedForMemory).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1_000);
});

test("the watch a job's end wakes says what killed it, after the code and before the output", () => {
    const job = opened("conv-kill-wake");
    end(job, 137);
    writeFileSync(join(job.dir, MEMORY_KILL_FILE), `${killSentence(kill())}\n`);
    const ran = spawnSync("sh", ["-c", completionCheck(job)], { encoding: "utf8" });
    expect(ran.status).toBe(0);
    expect(ran.stdout).toBe(`exit 137\n${killSentence(kill())}\nloading assets\n`);
    // A job still running is not met.
    rmSync(join(job.dir, STATUS_FILE));
    expect(spawnSync("sh", ["-c", completionCheck(job)]).status).toBe(1);
});
