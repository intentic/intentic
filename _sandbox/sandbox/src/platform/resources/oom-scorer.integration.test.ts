import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { type OomScorer, startOomScorer } from "./oom-scorer.js";

/* The half the unit tests cannot reach: real children of this process, scored through procfs. A score
   that parses and never lands on a process looks exactly like one that did, so only the kernel's own file proves it. */

const SETTLE_MS = 5_000;
const POLL_MS = 50;

const scoreOf = async (pid: number): Promise<number> => Number((await readFile(`/proc/${String(pid)}/oom_score_adj`, "utf8")).trim());

// Waits for the file to read `wanted`, and returns what it last read, so a miss fails with the value it had.
const settledScore = async (pid: number, wanted: number): Promise<number> => {
    const deadline = Date.now() + SETTLE_MS;
    let last = await scoreOf(pid);
    while (last !== wanted && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        last = await scoreOf(pid);
    }
    return last;
};

const children: ChildProcess[] = [];
let scorer: OomScorer | undefined;

afterEach(() => {
    scorer?.stop();
    for (const child of children.splice(0)) {
        child.kill("SIGKILL");
    }
});

const child = (command: string, args: readonly string[]): ChildProcess => {
    const started = spawn(command, args, { stdio: "ignore" });
    children.push(started);
    return started;
};

// Children inherit this process's score and the scorer never lowers one, so every target sits between it and the max of 1000.
const INHERITED = process.platform === "linux" ? Number(readFileSync("/proc/self/oom_score_adj", "utf8").trim()) : 0;
const STEP = Math.floor((1_000 - INHERITED) / 4);
const [LOW, MID, HIGH] = [INHERITED + STEP, INHERITED + 2 * STEP, INHERITED + 3 * STEP];

const describeLinux = process.platform === "linux" && STEP > 0 ? describe : describe.skip;

describeLinux("the scorer ranks the daemon's children for the kernel's OOM killer", () => {
    test("a child the resolver names is raised to its score", async () => {
        scorer = startOomScorer(({ command }) => (command.includes("sleep 31") ? LOW : undefined));
        const sleeper = child("sleep", ["31"]);
        expect(await settledScore(sleeper.pid ?? 0, LOW)).toBe(LOW);
    });

    test("what the child had already forked is raised with it", async () => {
        const shell = child("sh", ["-c", "sleep 32 & wait"]);
        // Forked before the scorer starts, so only the walk down the tree can reach the grandchild.
        await new Promise((resolve) => setTimeout(resolve, 200));
        const grandchild = Number((await readFile(`/proc/${String(shell.pid ?? 0)}/task/${String(shell.pid ?? 0)}/children`, "utf8")).trim());
        scorer = startOomScorer(({ command }) => (command.includes("sleep 32 & wait") ? MID : undefined));
        expect(await settledScore(shell.pid ?? 0, MID)).toBe(MID);
        expect(await settledScore(grandchild, MID)).toBe(MID);
    });

    test("a child already ranked above the resolver's score keeps its own", async () => {
        scorer = startOomScorer(({ command }) => (command.includes("sleep 33") ? MID : undefined));
        // choom execs sleep in place, so the pid is the sleeper's; a lower score written over it would read MID.
        const ranked = child("choom", ["-n", String(HIGH), "--", "sleep", "33"]);
        const plain = child("sleep", ["33"]);
        // The plain one landing proves a pass reached both; the pass after it is the margin for the other.
        expect(await settledScore(plain.pid ?? 0, MID)).toBe(MID);
        await new Promise((resolve) => setTimeout(resolve, 600));
        expect(await scoreOf(ranked.pid ?? 0)).toBe(HIGH);
    });
});
