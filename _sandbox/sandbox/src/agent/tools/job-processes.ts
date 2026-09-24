import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseProcStat } from "../../platform/resources/proc-stat.js";

// A background job's processes, found the way the kernel groups them rather than by parentage. bin/tmux-run runs every
// job pane as `bash <job dir>/runner`, and tmux makes that the leader of a session of its own, which everything the
// command starts keeps: a dev server whose launcher exited and left it parented by init still names the pane's session.

const NUMERIC = /^\d+$/u;

// How long a stopped job's processes get to exit on SIGTERM before SIGKILL, and how often they are looked at meanwhile.
const TERM_GRACE_MS = 3_000;
const POLL_MS = 100;

const pidsOf = async (procRoot: string): Promise<number[]> =>
    (await readdir(procRoot).catch(() => [] as string[])).filter((entry) => NUMERIC.test(entry)).map(Number);

// The runner's argv as tmux-run writes its pane command; anything else naming the dir (a `cat` of its output) is not it.
const runnerArgv = (dir: string): string => `bash\0${join(dir, "runner")}\0`;

/** The pid leading each job dir's pane, for the dirs that have one running; the rest are absent. */
export const jobRunnerPids = async (dirs: readonly string[], procRoot = "/proc"): Promise<Map<string, number>> => {
    const wanted = new Map(dirs.map((dir) => [runnerArgv(dir), dir]));
    const found = new Map<string, number>();
    if (wanted.size === 0) {
        return found;
    }
    for (const pid of await pidsOf(procRoot)) {
        const argv = await readFile(join(procRoot, String(pid), "cmdline"), "utf8").catch(() => "");
        const dir = wanted.get(argv);
        if (dir !== undefined) {
            found.set(dir, pid);
        }
    }
    return found;
};

/** Every process in the session `leader` leads, the leader itself excluded. */
const sessionMembers = async (leader: number, procRoot = "/proc"): Promise<number[]> => {
    const members: number[] = [];
    for (const pid of await pidsOf(procRoot)) {
        if (pid === leader) {
            continue;
        }
        const stat = await readFile(join(procRoot, String(pid), "stat"), "utf8").catch(() => "");
        if (parseProcStat(stat)?.session === leader) {
            members.push(pid);
        }
    }
    return members;
};

const signal = (pids: readonly number[], name: NodeJS.Signals): void => {
    for (const pid of pids) {
        try {
            process.kill(pid, name);
        } catch {
            // Already gone, which is the point.
        }
    }
};

const pause = (ms: number): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, ms).unref();
    });

/**
 * Ends what a job pane runs, leaving the runner itself to see its command die and publish the status file as it does
 * for any exit. SIGTERM first; whatever is still there after the grace gets SIGKILL. Answers whether anything was
 * signalled at all.
 */
export const endSession = async (leader: number, procRoot = "/proc", graceMs = TERM_GRACE_MS): Promise<boolean> => {
    const first = await sessionMembers(leader, procRoot);
    if (first.length === 0) {
        return false;
    }
    signal(first, "SIGTERM");
    const deadline = Date.now() + graceMs;
    let left = first;
    while (left.length > 0 && Date.now() < deadline) {
        await pause(POLL_MS);
        left = await sessionMembers(leader, procRoot);
    }
    signal(left, "SIGKILL");
    return true;
};
