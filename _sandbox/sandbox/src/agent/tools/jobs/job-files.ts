import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jobRunnerPids } from "./job-processes.js";
import { appendRunFile, renameRunFile, writeRunFile } from "./run-files.js";

// The files bin/tmux-run and the daemon keep in an agent run's capture dir, and the boot pass over the ones a restart cut.

// Published by atomic rename by bin/tmux-run once the command has exited; its existence is completion.
export const STATUS_FILE = "status";
// The pane's combined output, tee'd as it runs.
export const OUTPUT_FILE = "out";
// Written by bin/tmux-run before it touches tmux; its absence once the turn is gone means the command never ran.
export const COMMAND_FILE = "cmd";
// The status body of a job whose command never ran, which no exit code can be.
export const NEVER_RAN = "never-ran";
// The status body of a run a restart took down mid-command, which left no exit code to read.
const LOST = "lost";
// The job itself, rewritten whole as it is named and adopted, so a restarted daemon can take it back.
export const JOB_FILE = "job.json";
// Why its command ended, when it was killed for memory: the kill's one sentence (system/resources/memory-kill-words.ts,
// written by memory-kills.ts), which its report, the watch its end wakes and `wait` all say in place of a bare exit 137.
export const MEMORY_KILL_FILE = "memory-kill";
// Why it was stopped, when something other than the agent or the person stopped it (a runtime's own time limit): one
// sentence (job-stop-reasons.ts), said beside the bare 143 wherever the memory kill's would be.
export const STOP_REASON_FILE = "stop-reason";

// Every agent run's capture dir, a job's (`intentic-run-job-`) or a foreground call's filed as one when it ran past its
// time (`intentic-run-`), under the tmp sweep's prefix.
const RUN_DIR_PREFIX = "intentic-run-";

/**
 * Once at boot, before the watches come back: every run filed as a job that has no status and no runner left was taken
 * down by the restart, so nothing will ever publish its end. Its end is written down for it (status `lost`, never run
 * when it never started), and the watch its conversation was handed reports that at its first look, instead of waiting
 * out its six hours on a file no runner is left to write. On 2026-10-04 a container restart did that to a watch on an
 * `npm exec` that had died with the container: re-armed for two and a half more hours, to wake a conversation whose
 * work had already landed. A runner still alive (the daemon restarted, the panes did not) is left to run.
 */
export const settleLostRuns = async (root: string = tmpdir(), procRoot = "/proc"): Promise<readonly string[]> => {
    const unfinished = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith(RUN_DIR_PREFIX))
        .map((entry) => join(root, entry.name))
        .filter((dir) => existsSync(join(dir, JOB_FILE)) && !existsSync(join(dir, STATUS_FILE)));
    if (unfinished.length === 0) {
        return [];
    }
    return endRunnerless(unfinished, procRoot, "\n--- intentic: the sandbox restarted while this ran, and the command did not survive the restart\n");
};

/* RUNS THE DAEMON CARRIES ITSELF (2026-11-17, the shinobi-society audit). A job the daemon runs in its own process (a
   ChatGPT image made in the owner's browser, daemon-jobs.ts) has no runner for /proc to find, and its end is written by
   this process: while it is held here it is alive, and the runnerless sweep leaves it be. Held in memory only, so a
   restart, which takes the work with it, finds it unheld at boot and writes it down as lost like any other run. */
const DAEMON_HELD = new Set<string>();

/** Marks a run in `dir` as carried by this daemon process; answers the release, called once its end is written. */
export const holdDaemonRun = (dir: string): (() => void) => {
    DAEMON_HELD.add(dir);
    return () => void DAEMON_HELD.delete(dir);
};

// Writes the end of every run in `dirs` whose runner is gone, which no runner is left to publish; answers those dirs.
const endRunnerless = async (dirs: readonly string[], procRoot: string, why: string): Promise<readonly string[]> => {
    const alive = await jobRunnerPids(dirs, procRoot);
    const lost = dirs.filter((dir) => !alive.has(dir) && !DAEMON_HELD.has(dir) && !existsSync(join(dir, STATUS_FILE)));
    for (const dir of lost) {
        const started = existsSync(join(dir, COMMAND_FILE)) || existsSync(join(dir, OUTPUT_FILE));
        try {
            appendRunFile(dir, OUTPUT_FILE, started ? why : "--- intentic: this command never reached a terminal, so it never ran\n");
            writeRunFile(dir, `${STATUS_FILE}.part`, `${started ? LOST : NEVER_RAN}\n`);
            renameRunFile(dir, `${STATUS_FILE}.part`, STATUS_FILE);
        } catch {
            // allow(silent-catch): a dir that cannot be written is one the tmp sweep is already taking; its watch reads that as broken.
        }
    }
    return lost;
};

// How long a job is given for its pane's runner to appear before a look that finds none reads it as gone.
const RUNNER_GRACE_MS = 60_000;

/* A RUNNER GONE WHILE THE DAEMON RAN (2026-11-05). A job's end is its status file, which its runner publishes; a runner
   killed with its pane (a hangup, a kill of its whole process group, a tmux server gone) publishes none, and only boot
   looked for runs left that way. marcin.milczarek's four servers, kept for him, read "running" for four hours with
   nothing listening on any port; a job killed that way here read "running" with no process left. The end poll asks this
   too: every unfinished job past its grace whose runner is gone has its end written, as boot writes it. Never throws. */
export const settleRunnerlessJobs = async (jobs: readonly { readonly dir: string; readonly startedAt: number }[], now = Date.now(), procRoot = "/proc"): Promise<readonly string[]> => {
    const due = jobs.filter((job) => now - job.startedAt >= RUNNER_GRACE_MS && !existsSync(join(job.dir, STATUS_FILE))).map((job) => job.dir);
    if (due.length === 0) {
        return [];
    }
    try {
        return await endRunnerless(due, procRoot, "\n--- intentic: this command's terminal went away without it publishing an exit, so it is no longer running\n");
    } catch {
        // allow(silent-catch): /proc unreadable for one look leaves every job as it was; the next poll looks again.
        return [];
    }
};
