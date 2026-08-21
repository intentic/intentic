import { join } from "node:path";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import type { Logger } from "pino";
import { discoverRepos } from "../workspace/repo-discovery.js";
import type { WorkspacePaths } from "../workspace/workspace.js";

/* GIT HOUSEKEEPING, the daemon IS the scheduler.
 *
 * `git maintenance start`, the usual way to turn this on, registers a systemd timer or a crontab entry. A
 * sandbox container has neither (pid 1 is docker-init; no crond runs), so that call would write a schedule
 * nothing ever fires. The daemon already owns every other unattended sweep in this codebase, the archive
 * sweep, the log prune, the session reap, so maintenance joins them rather than inventing a second clock.
 *
 * WHY THIS REPO NEEDS IT more than a normal one: a conversation mints a branch per repo and a commit per turn,
 * so refs and loose objects accumulate at fleet speed rather than human speed. The workspace this was written
 * against had 133 loose ref files and 4,321 loose objects across 6 packs, every ref lookup a stat per file,
 * every object lookup a miss through six pack indexes before falling back to the loose store. That is a tax on
 * every git command the daemon runs (status on each workspace change, merge-base per standing probe, the diffs
 * behind every review) and on every command the USER runs, which is what a slow commit actually feels like.
 *
 * WHICH TASKS. The four incremental ones, and deliberately NOT `gc`:
 *   · pack-refs          : 133 loose ref files become one packed-refs read
 *   · commit-graph       , the daemon's merge-base/ancestry work (anchorOf, per-repo standings) is exactly what
 *                           a commit-graph accelerates, and it is the cheapest of the four to keep current
 *   · loose-objects      , sweeps the loose store into a pack, bounded at 50k objects per run
 *   · incremental-repack , consolidates those packs so lookups stop fanning out across all of them
 * `gc` is the one operation here that can stall a live turn's git command, a full repack plus prune over a
 * repo with two dozen active worktrees, and everything it buys that this complaint is about, the four above
 * already deliver. What it uniquely adds is reclaiming UNREACHABLE objects, and those only arrive here when an
 * agent is discarded outright; if that ever becomes the dominant cost, `gc` is one more entry in this list.
 *
 * No `--auto`. It reads as the safer choice and is the wrong one: measured on git 2.39, `--auto --task=pack-refs`
 * left 41 loose refs untouched where the plain run packed all of them, the auto conditions are tuned for
 * repos that grow at human speed, so the task that matters most here is the one --auto skips. Every task in the
 * list is bounded by its own batch limits, so running them unconditionally is cheap enough to not need gating.
 */

/* ONE INVOCATION PER TASK, in the order written, because a single `run --task=a --task=b` does NOT honor it.
 * git sorts the selected tasks by selection order DESCENDING (builtin/gc.c compare_tasks_by_selection), so
 * this list ran backwards: `incremental-repack` went FIRST, indexing packs that `loose-objects` had not yet
 * created, which is a hard error rather than a no-op on any repo whose objects are still loose, a fresh
 * workspace, on every boot ("error: no pack files to index" / "task 'incremental-repack' failed"). Confirmed
 * under GIT_TRACE on git 2.39.5: the one process emitted multi-pack-index, then prune-packed + pack-objects,
 * then commit-graph, then pack-refs. Exactly reversed.
 *
 * Four processes instead of one is the price of the order being OURS rather than a detail of whichever git the
 * image ships, and it buys per-task isolation: a task that fails is named in its own log line and costs only
 * itself, where before one failure marked the whole repo's sweep failed and said nothing about which. */
const TASKS = ["pack-refs", "commit-graph", "loose-objects", "incremental-repack"] as const;

// `incremental-repack` writes a multi-pack-index over the repo's packs, and git treats an object store with no
// pack at all as an ERROR, not as nothing to do. `loose-objects` just above mints the first pack, but only
// out of loose objects, so a repo holding NO objects (a bare `git init` the user has yet to commit into) stays
// packless and would fail this one task on every sweep, forever. Asking first is what keeps it quiet.
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

// Sequential across repos on purpose: these are IO-bound and the user is working in this workspace while they
// run. Best-effort per task, like every other convergence pass, a repo that cannot be maintained (an unborn
// HEAD, a git dir mid-relocation) must not stop the ones that can, and must never reach the caller.
export const runGitMaintenance = async (workspace: WorkspacePaths, logger: Logger, git: GitRunner = defaultGit): Promise<void> => {
    for (const repo of ["root", ...(await discoverRepos(workspace.root))]) {
        const dir = repo === "root" ? workspace.root : join(workspace.root, repo);
        for (const task of TASKS) {
            await runTask(dir, task, git).catch((error: unknown) => logger.warn({ err: error, repo, task }, "git maintenance: task failed"));
        }
    }
};
