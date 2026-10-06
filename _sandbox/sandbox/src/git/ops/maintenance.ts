import { lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import { defaultGit, gitProcessRunning, type GitRunner, STALE_LOCK_MS } from "@intentic/base/git";
import type { Logger } from "pino";
import type { Chore } from "../../system/chore-clock.js";
import { discoverRepos } from "../../workspace/layout/repo-discovery.js";
import type { WorkspacePaths } from "../../workspace/workspace.js";
import { commonDirOf, gitDirOf } from "../git-dir.js";
import type { GitQuietProbe } from "./stale-git-locks.js";

// Git housekeeping the daemon runs itself, since a sandbox has no systemd/cron for `git maintenance start` to register
// with. Runs the four incremental tasks below, not `gc` (can stall a live git command; git-gc.ts runs it daily while no
// turn is live) or `--auto` (tuned for repos that grow at human speed, not one branch per turn).

// The clock's unit, spelled here: a value import from system/ would close a cycle (system/ imports git/).
const HOUR_MS = 60 * 60_000;

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

/**
 * Whether a `maintenance run` in this checkout's repository would do anything (2026-10-05). git takes
 * objects/maintenance.lock for every run and, with `--quiet`, skips without a word while it exists: a lock left by a run
 * that was killed made every later one a silent no-op. A lock younger than STALE_LOCK_MS is a run in progress, so this
 * one is skipped and says so; an older one no running git can hold (@intentic/base/git locks.ts) is removed, logged, and the
 * run goes ahead; an older one a git may hold is left, and the skip is logged.
 */
export const maintenanceMayRun = async (
    dir: string,
    repo: string,
    logger: Pick<Logger, "info" | "warn">,
    probe: GitQuietProbe = {},
): Promise<boolean> => {
    const gitDir = await gitDirOf(dir);
    // Not a repository git can find from here: the run itself fails, and that failure is logged where it happens.
    if (gitDir === undefined) {
        return true;
    }
    const lock = join(await commonDirOf(gitDir), "objects", "maintenance.lock");
    const stats = await lstat(lock).catch(undefinedIfMissing);
    if (stats === undefined) {
        return true;
    }
    const ageMs = (probe.now ?? Date.now)() - stats.mtimeMs;
    const ageMinutes = Math.round(ageMs / 60_000);
    if (ageMs <= STALE_LOCK_MS) {
        logger.info({ repo, ageMinutes }, "git maintenance: another run holds the lock, this one is skipped");
        return false;
    }
    const running = await (probe.gitRunning ?? gitProcessRunning)();
    if (running !== false) {
        logger.warn(
            { repo, lock, ageMinutes, git: running === true ? "running" : "unknown" },
            "git maintenance: an old maintenance.lock a git may still hold, skipped",
        );
        return false;
    }
    await rm(lock, { force: true });
    logger.warn({ repo, lock, ageMinutes }, "git maintenance: removed a stale maintenance.lock no git was holding");
    return true;
};

// Sequential across repos on purpose (IO-bound, user is working live); best-effort per task, so one unmaintainable repo
// never stops the rest or reaches the caller.
export const runGitMaintenance = async (
    workspace: WorkspacePaths,
    logger: Logger,
    git: GitRunner = defaultGit,
    probe: GitQuietProbe = {},
): Promise<void> => {
    try {
        for (const repo of ["root", ...(await discoverRepos(workspace.root))]) {
            const dir = repo === "root" ? workspace.root : join(workspace.root, repo);
            const mayRun = await maintenanceMayRun(dir, repo, logger, probe).catch((error: unknown) => {
                logger.warn({ err: error, repo }, "git maintenance: could not read the maintenance lock, running anyway");
                return true;
            });
            if (!mayRun) {
                continue;
            }
            for (const task of TASKS) {
                await runTask(dir, task, git).catch((error: unknown) => logger.warn({ err: error, repo, task }, "git maintenance: task failed"));
            }
        }
    } catch (error) {
        logger.warn({ err: error }, "git maintenance: the pass failed");
    }
};

export interface GitMaintenanceChoreDeps {
    readonly workspace: WorkspacePaths;
    readonly logger: Logger;
}

// The hourly pass as a chore on the housekeeping clock; held for nothing, as it always ran.
export const gitMaintenanceChore = (deps: GitMaintenanceChoreDeps): Chore => ({
    name: "git-maintenance",
    everyMs: HOUR_MS,
    run: () => runGitMaintenance(deps.workspace, deps.logger),
});
