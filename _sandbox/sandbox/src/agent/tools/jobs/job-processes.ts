import { join } from "node:path";
import { parentOf, pidsOf, procFile } from "../../../seams/session-processes.js";

// A background job's processes, found the way the kernel groups them rather than by parentage. bin/tmux-run runs every
// job pane as `bash <job dir>/runner`, and tmux makes that the leader of a session of its own, which everything the
// command starts keeps: a dev server whose launcher exited and left it parented by init still names the pane's session.

// The runner's argv as tmux-run writes its pane command; anything else naming the dir (a `cat` of its output) is not it.
const runnerArgv = (dir: string): string => `bash\0${join(dir, "runner")}\0`;

/* THE RUNNER, NOT ITS FORKS. The runner starts its command as a pipeline, and each side of it is a fork of the runner
 * that carries the runner's argv until it execs its own: a look in that moment sees two or three processes with the
 * runner's command line. The pane's leader is the one whose parent is none of them; the last one listed, as this first
 * took, was a fork about to become the command, whose pid leads no session, so a run looked at through it never had a
 * reader (run 38309408964's verify-clocks). */
const outermost = async (procRoot: string, pids: readonly number[]): Promise<number | undefined> => {
    if (pids.length < 2) {
        return pids[0];
    }
    for (const pid of pids) {
        const parent = parentOf(await procFile(join(procRoot, String(pid), "stat")));
        if (parent !== undefined && !pids.includes(parent)) {
            return pid;
        }
    }
    return pids[0];
};

/** The pid leading each job dir's pane, for the dirs that have one running; the rest are absent. */
export const jobRunnerPids = async (dirs: readonly string[], procRoot = "/proc"): Promise<Map<string, number>> => {
    const wanted = new Map(dirs.map((dir) => [runnerArgv(dir), dir]));
    const found = new Map<string, number>();
    if (wanted.size === 0) {
        return found;
    }
    const matches = new Map<string, number[]>();
    for (const pid of await pidsOf(procRoot)) {
        const argv = await procFile(join(procRoot, String(pid), "cmdline"));
        const dir = wanted.get(argv);
        if (dir !== undefined) {
            matches.set(dir, [...(matches.get(dir) ?? []), pid]);
        }
    }
    for (const [dir, pids] of matches) {
        const leader = await outermost(procRoot, pids);
        if (leader !== undefined) {
            found.set(dir, leader);
        }
    }
    return found;
};

