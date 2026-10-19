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
    const alive = await jobRunnerPids(unfinished, procRoot);
    const lost = unfinished.filter((dir) => !alive.has(dir));
    for (const dir of lost) {
        const started = existsSync(join(dir, COMMAND_FILE)) || existsSync(join(dir, OUTPUT_FILE));
        try {
            appendRunFile(
                dir,
                OUTPUT_FILE,
                started ? "\n--- intentic: the sandbox restarted while this ran, and the command did not survive the restart\n" : "--- intentic: this command never reached a terminal, so it never ran\n",
            );
            writeRunFile(dir, `${STATUS_FILE}.part`, `${started ? LOST : NEVER_RAN}\n`);
            renameRunFile(dir, `${STATUS_FILE}.part`, STATUS_FILE);
        } catch {
            // allow(silent-catch): a dir that cannot be written is one the tmp sweep is already taking; its watch reads that as broken.
        }
    }
    return lost;
};
