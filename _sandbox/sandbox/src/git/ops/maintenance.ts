import { join } from "node:path";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import type { Logger } from "pino";
import { discoverRepos } from "../../workspace/layout/repo-discovery.js";
import type { WorkspacePaths } from "../../workspace/workspace.js";

// Git housekeeping the daemon runs itself, since a sandbox has no systemd/cron for `git maintenance start` to register
// with. Runs the four incremental tasks below, not `gc` (can stall a live git command) or `--auto` (tuned for repos
// that grow at human speed, not one branch per turn).

// One run per task: a combined multi-task run sorts tasks by selection order descending, reversing this list.
const TASKS = ["pack-refs", "commit-graph", "loose-objects", "incremental-repack"] as const;

// git treats a packless object store as an ERROR for `incremental-repack`, not nothing to do; a repo with zero objects
// (never committed into) stays packless forever, so this is checked first.
const packCount = async (dir: string, git: GitRunner): Promise<number> => {
    const { stdout } = await git(dir, ["count-objects", "-v"]);
    return Number(/^packs: (\d+)$/m.exec(stdout)?.[1] ?? 0);
};

// The precondition rides with the task that needs it, so failing to ASK fails only that task too.
const runTask = async (dir: string, task: (typeof TASKS)[number], git: GitRunner): Promise<void> => {
    if (task === "incremental-repack" && (await packCount(dir, git)) === 0) {
        return;
    }
    await git(dir, ["maintenance", "run", "--quiet", `--task=${task}`]);
};

// Sequential across repos on purpose (IO-bound, user is working live); best-effort per task, so one unmaintainable repo
// never stops the rest or reaches the caller.
export const runGitMaintenance = async (workspace: WorkspacePaths, logger: Logger, git: GitRunner = defaultGit): Promise<void> => {
    for (const repo of ["root", ...(await discoverRepos(workspace.root))]) {
        const dir = repo === "root" ? workspace.root : join(workspace.root, repo);
        for (const task of TASKS) {
            await runTask(dir, task, git).catch((error: unknown) => logger.warn({ err: error, repo, task }, "git maintenance: task failed"));
        }
    }
};
