import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requires } from "@intentic/testing/requires";
import { memoryFleet } from "../../../testing.js";
import { waitForWork, workWaitAnswer } from "../../subagents/work-wait.js";
import { openBackgroundJob } from "./background-jobs.js";
import { INPUT_WAIT_MS, sampleRuns } from "./input-wait.js";
import { followRun, INPUT_WAIT_FILE, inputWaitAt, lookAtRuns } from "./input-wait-follow.js";
import { jobRunnerPids } from "./job-processes.js";

// Real programs on a real terminal, read through the real /proc: each runs under a runner shaped like bin/tmux-run's,
// leading a session whose stdin is a pseudo-terminal, as a pane's is. `script` makes the terminal; its own stdin is a pipe
// held open, so it never forwards an end of input to the program waiting on it.

const terminal = requires(existsSync("/usr/bin/script"), "util-linux script at /usr/bin/script");

const dirs: string[] = [];
const children: ReturnType<typeof spawn>[] = [];
afterEach(() => {
    for (const child of children.splice(0)) {
        try {
            process.kill(-(child.pid ?? 0), "SIGKILL");
        } catch {
            // allow(silent-catch): the session already ended.
        }
    }
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

// bin/tmux-run's runner, minus the tmux options: the command teed into `out`, then its code published by rename.
const RUNNER = (dir: string): string =>
    [`bash ${dir}/cmd 2>&1 | tee -a ${dir}/out`, "code=${PIPESTATUS[0]}", `echo "$code" > ${dir}/status.part`, `mv ${dir}/status.part ${dir}/status`].join("\n");

// A run of `command` on a terminal of its own, once its runner leads a session; in `dir` when one is given (a job's).
const onTerminal = async (command: string, given?: string): Promise<{ dir: string; leader: number }> => {
    const dir = given ?? mkdtempSync(join(tmpdir(), "intentic-run-"));
    dirs.push(dir);
    writeFileSync(join(dir, "cmd"), `${command}\n`);
    writeFileSync(join(dir, "runner"), RUNNER(dir));
    // SHELL=bash: script runs `$SHELL -c`, and bash execs a lone command, so the runner itself leads the session.
    const child = spawn("script", ["-qfc", `bash ${join(dir, "runner")}`, "/dev/null"], {
        detached: true,
        stdio: ["pipe", "ignore", "ignore"],
        env: { ...process.env, SHELL: "/bin/bash" },
    });
    children.push(child);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        const leader = (await jobRunnerPids([dir])).get(dir);
        if (leader !== undefined && existsSync(join(dir, "out"))) {
            return { dir, leader };
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`the runner for ${command} never started`);
};

// The run's reader as /proc shows it, once the program has had the moment it takes to reach its prompt.
const readerOf = async (run: { dir: string; leader: number }, settleMs = 4_000) => {
    const deadline = Date.now() + settleMs;
    let sample;
    do {
        sample = (await sampleRuns(new Map([["run", { leader: run.leader, outputPath: join(run.dir, "out") }]]))).get("run");
        if (sample?.reader !== undefined) {
            return sample.reader;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    return sample?.reader;
};

describe("a run reading its terminal", () => {
    test.skipIf(!terminal.runs)(terminal.title("a shell's read is found reading the terminal, and named by its command line"), async () => {
        const run = await onTerminal(`read -p "Proceed? (y) " answer; echo "got $answer"`);
        expect(await readerOf(run)).toEqual({ pid: expect.any(Number), program: `bash ${join(run.dir, "cmd")}` });
    });

    test.skipIf(!terminal.runs)(terminal.title("node's readline, which is how npm asks, is found through the epoll set that holds the terminal"), async () => {
        const run = await onTerminal(`node -e 'require("readline").createInterface({ input: process.stdin, output: process.stdout }).question("Ok to proceed? (y) ", () => {})'`);
        expect((await readerOf(run))?.program).toMatch(/^node -e /u);
    });

    test.skipIf(!terminal.runs)(terminal.title("a sleep is not reading anything"), async () => {
        const run = await onTerminal("sleep 60");
        expect(await readerOf(run, 1_500)).toBeUndefined();
    });

    test.skipIf(!terminal.runs)(terminal.title("a server that also reads its terminal for keys is serving, not waiting"), async () => {
        const run = await onTerminal(
            `node -e 'require("http").createServer(() => {}).listen(0, "127.0.0.1"); require("readline").createInterface({ input: process.stdin }).on("line", () => {})'`,
        );
        expect(await readerOf(run, 2_500)).toBeUndefined();
    });
});

describe("following a run", () => {
    test.skipIf(!terminal.runs)(terminal.title("a prompt still for the window is a wait, marked beside the capture for tmux-run, and cleared once the run ends"), async () => {
        const run = await onTerminal(`read -p "Proceed? (y) " answer`);
        expect(await readerOf(run)).toMatchObject({ program: `bash ${join(run.dir, "cmd")}` });
        const heard: unknown[] = [];
        const t0 = Date.now();
        const unfollow = followRun(run.dir, (wait) => heard.push(wait), t0 - 10_000);
        try {
            await lookAtRuns("/proc", t0);
            expect(inputWaitAt(run.dir)).toBeUndefined();
            await lookAtRuns("/proc", t0 + INPUT_WAIT_MS);
            expect(inputWaitAt(run.dir)).toEqual({ since: t0, pid: expect.any(Number), program: `bash ${join(run.dir, "cmd")}` });
            expect(readFileSync(join(run.dir, INPUT_WAIT_FILE), "utf8")).toMatch(new RegExp(`^bash ${join(run.dir, "cmd")} \\(pid \\d+\\)\\n$`, "u"));
            writeFileSync(join(run.dir, "status"), "0\n");
            await lookAtRuns("/proc", t0 + INPUT_WAIT_MS + 2_000);
            expect(inputWaitAt(run.dir)).toBeUndefined();
            expect(existsSync(join(run.dir, INPUT_WAIT_FILE))).toBe(false);
            expect(heard).toEqual([expect.objectContaining({ since: t0 }), undefined]);
        } finally {
            unfollow();
        }
    });

    test.skipIf(!terminal.runs)(terminal.title("a run that keeps printing is never a wait"), async () => {
        const run = await onTerminal(`while true; do echo tick; sleep 0.2; done`);
        const t0 = Date.now();
        const unfollow = followRun(run.dir, undefined, t0 - 10_000);
        try {
            for (let step = 0; step <= 5; step += 1) {
                await lookAtRuns("/proc", t0 + step * 2_000);
                await new Promise((resolve) => setTimeout(resolve, 300));
            }
            expect(inputWaitAt(run.dir)).toBeUndefined();
        } finally {
            unfollow();
        }
    });
});

describe("waiting on a job at a prompt", () => {
    const actors = memoryFleet().conversations;

    // A background job of conversation `conversationId` running `command` on a terminal.
    const jobAt = async (conversationId: string, command: string) => {
        const job = openBackgroundJob({ conversationId, profile: {}, conversations: actors }, { command, session: `agent-${conversationId}` });
        if (job === undefined) {
            throw new Error("the job dir could not be minted");
        }
        await onTerminal(command, job.dir);
        return job;
    };

    // Looks on a clock running ahead of the real one until `settled` says the wait answered, or the deadline passes.
    const driveUntil = async (settled: () => boolean, rounds = 40): Promise<void> => {
        let ahead = Date.now() + 10_000;
        for (let round = 0; round < rounds && !settled(); round += 1) {
            await lookAtRuns("/proc", ahead);
            ahead += INPUT_WAIT_MS;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
    };

    test.skipIf(!terminal.runs)(terminal.title("a wait counting blocked comes back blocked, naming the process and saying waiting again will not end it"), async () => {
        const job = await jobAt("conv-iw-blocked", `npx_asks() { read -p "Ok to proceed? (y) " answer; }; npx_asks 2>&1 | tail -10`);
        let answered = false;
        const wait = waitForWork(actors, "conv-iw-blocked", { target: job.id, until: ["blocked", "finished"], timeoutMs: 20_000 }).finally(() => {
            answered = true;
        });
        await driveUntil(() => answered);
        const result = await wait;
        expect(result).toMatchObject({
            outcome: "blocked",
            job: { id: job.id, running: true, waitingForInput: { program: `bash ${join(job.dir, "cmd")}`, pid: expect.any(Number) } },
        });
        const answer = workWaitAnswer(result, { pendingQuestion: () => undefined, report: () => undefined, landing: () => undefined });
        expect(answer["note"]).toContain(`Stop it with TaskStop (task_id "${job.id}")`);
    });

    test.skipIf(!terminal.runs)(terminal.title("a wait counting only finished keeps parking: the prompt is not an exit"), async () => {
        const job = await jobAt("conv-iw-finished", `read -p "Ok to proceed? (y) " answer`);
        let answered = false;
        const wait = waitForWork(actors, "conv-iw-finished", { target: job.id, until: ["finished"], timeoutMs: 1_500 }).finally(() => {
            answered = true;
        });
        await driveUntil(() => answered, 10);
        expect(await wait).toMatchObject({ outcome: "timeout", job: { id: job.id, running: true } });
    });
});
