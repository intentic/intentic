import { readdir, readFile, writeFile } from "node:fs/promises";
import { readText } from "./cgroup.js";
import { type OomScoreResolver, raisedScore } from "./oom-priority.js";
import { commandOf, ownerOf } from "./process-scan.js";

// The front renices the daemon's children and keeps them out of its cgroup leaf; only the daemon can name the
// conversation a child runs for, so ranking them for the OOM killer stays here.
const POLL_MS = 250;

const childPids = (text: string): number[] =>
    text
        .trim()
        .split(/\s+/u)
        .filter((value) => value !== "")
        .map(Number)
        .filter((pid) => Number.isSafeInteger(pid) && pid > 0);

// Every child of a process, across all its threads: a child forked off a worker thread is listed under that thread.
const childrenOf = async (pid: number): Promise<number[]> => {
    const tasks = await readdir(`/proc/${String(pid)}/task`).catch((): string[] => []);
    const lists = await Promise.all(tasks.map((task) => readText(`/proc/${String(pid)}/task/${task}/children`)));
    return lists.flatMap((list) => childPids(list ?? ""));
};

// The process first, then what it already forked: anything it forks after the first write inherits the score.
const raiseTree = async (pid: number, score: number): Promise<void> => {
    const path = `/proc/${String(pid)}/oom_score_adj`;
    const current = Number((await readText(path))?.trim());
    const next = Number.isFinite(current) ? raisedScore(current, score) : undefined;
    if (next !== undefined) {
        await writeFile(path, String(next)).catch(() => undefined);
    }
    for (const child of await childrenOf(pid)) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- a first sight's tree is a handful of processes.
        await raiseTree(child, score);
    }
};

export interface OomScorer {
    readonly stop: () => void;
}

export const startOomScorer = (resolve: OomScoreResolver): OomScorer => {
    if (process.platform !== "linux") {
        return { stop: () => undefined };
    }
    const path = `/proc/self/task/${String(process.pid)}/children`;
    const scored = new Set<number>();
    // A child caught between fork and exec still reads as the daemon; it is scored on a later pass, as what it became.
    const ownCommandLine = readText("/proc/self/cmdline");
    // Whether the child was read as itself, so a pass that caught it mid-exec tries again.
    const score = async (pid: number): Promise<boolean> => {
        const [comm, cmdline, environ] = await Promise.all([
            readText(`/proc/${String(pid)}/comm`),
            readText(`/proc/${String(pid)}/cmdline`),
            readText(`/proc/${String(pid)}/environ`),
        ]);
        if (cmdline === undefined || cmdline === (await ownCommandLine)) {
            return false;
        }
        const wanted = resolve({ command: commandOf((comm ?? "").trim(), cmdline), owner: ownerOf(environ ?? "") });
        if (wanted !== undefined) {
            await raiseTree(pid, wanted);
        }
        return true;
    };
    let running = false;
    const reconcile = async (): Promise<void> => {
        if (running) {
            return;
        }
        running = true;
        try {
            const current = new Set(childPids(await readFile(path, "utf8")));
            for (const pid of scored) {
                if (!current.has(pid)) {
                    scored.delete(pid);
                }
            }
            for (const pid of current) {
                // oxlint-disable-next-line eslint/no-await-in-loop -- one new child a pass is the ordinary case.
                if (!scored.has(pid) && (await score(pid))) {
                    scored.add(pid);
                }
            }
        } catch {
            // procfs may be hidden by a hardened runtime; the kernel then weighs size alone, as it would without us.
        } finally {
            running = false;
        }
    };
    void reconcile();
    const timer = setInterval(() => void reconcile(), POLL_MS);
    timer.unref();
    return { stop: () => clearInterval(timer) };
};
