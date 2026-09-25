import { join } from "node:path";
import { pidsOf, procFile } from "../../../seams/session-processes.js";

// A background job's processes, found the way the kernel groups them rather than by parentage. bin/tmux-run runs every
// job pane as `bash <job dir>/runner`, and tmux makes that the leader of a session of its own, which everything the
// command starts keeps: a dev server whose launcher exited and left it parented by init still names the pane's session.

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
        const argv = await procFile(join(procRoot, String(pid), "cmdline"));
        const dir = wanted.get(argv);
        if (dir !== undefined) {
            found.set(dir, pid);
        }
    }
    return found;
};

