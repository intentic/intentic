import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { errnoCode, isMissing } from "@intentic/base/errors";

// The processes of one terminal session, found the way the kernel groups them rather than by parentage. tmux starts
// every pane with setsid, so the pane's first process leads a session everything the pane's command starts keeps:
// a turbo task and a `bun test` worker in process groups of their own, a dev server whose launcher exited and left it
// parented by init. A kill by process group or a closed terminal reaches none of those; a kill by session reaches all.

const NUMERIC = /^\d+$/u;
// How long a session's processes get to exit on SIGTERM before SIGKILL, and how often they are looked at meanwhile.
const TERM_GRACE_MS = 3_000;
const POLL_MS = 100;

export const pidsOf = async (procRoot: string): Promise<number[]> =>
    // silent-catch: a proc root that can't be listed holds no processes to find, which is what an empty list says.
    (await readdir(procRoot).catch(() => [] as string[])).filter((entry) => NUMERIC.test(entry)).map(Number);

// One process's /proc file, empty once the process is gone: before the open that is a missing file, mid-read it is ESRCH.
export const procFile = (path: string): Promise<string> =>
    readFile(path, "utf8").catch((error: unknown) => {
        if (isMissing(error) || errnoCode(error) === "ESRCH") {
            return "";
        }
        throw error;
    });

// The session field of a /proc/<pid>/stat line: the fourth after the comm, which is bracketed by the first "(" and the
// LAST ")" since a comm may itself hold either. Read here rather than through platform/resources/proc-stat.ts: this is a
// seam both the agent's jobs and the managed panels end sessions through, and a value import of platform from here
// would close a cycle the daemon-boundaries check refuses.
export const sessionOf = (stat: string): number | undefined => {
    const session = Number(stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/u)[3]);
    return stat === "" || !Number.isInteger(session) ? undefined : session;
};

/** Every process in the session `leader` leads, the leader itself excluded. */
const sessionMembers = async (leader: number, procRoot = "/proc"): Promise<number[]> => {
    const members: number[] = [];
    for (const pid of await pidsOf(procRoot)) {
        if (pid === leader) {
            continue;
        }
        if (sessionOf(await procFile(join(procRoot, String(pid), "stat"))) === leader) {
            members.push(pid);
        }
    }
    return members;
};

const signal = (pids: readonly number[], name: NodeJS.Signals): void => {
    for (const pid of pids) {
        try {
            process.kill(pid, name);
        } catch (error) {
            // Already gone is the point; any other refusal leaves running a process the caller believes ended.
            if (errnoCode(error) !== "ESRCH") {
                throw error;
            }
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
