import { cp, lstat, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import type { Logger } from "pino";
import { repoGitDir } from "../history/history.js";
import { discoverRepos } from "../workspace/repo-discovery.js";
import type { WorkspacePaths } from "../workspace/workspace.js";

/* NO GIT DIR LIVES UNDER /work — the invariant that lets an isolated turn's worktree stand in for the
 * workspace root (agents/isolation.ts).
 *
 * A worktree's `.git` is a POINTER holding the absolute path of its admin dir inside the main repo's git dir.
 * While that git dir sits at /work/<repo>/.git, the pointer reads
 * `/work/<repo>/.git/worktrees/<id>` — and inside a namespace where /work IS the worktree, that path resolves
 * to the worktree's own pointer file. Git then answers "not a git repository" for every command the agent
 * runs: no status, no diff, no commit, and `land` has nothing to preserve.
 *
 * Moving the real git dir onto /history takes it out of the shadowed subtree entirely, so the SAME pointer
 * resolves identically inside and outside the namespace. Every repo the daemon creates already has this shape
 * (`--separate-git-dir`, history.ts repoGitDir); this converges the ones that arrived any other way — an agent's
 * own `git clone`, a repo restored from a backup, the workspace this daemon was developed in.
 *
 * Convergence, not a one-shot: it re-runs every boot, like ensureRootRepo's pointer rewrite and history's
 * healGitPointer, and does nothing at all once a repo is already in the target shape (the steady state).
 */

// Which shape is this repo's `.git` in? A pointer FILE is the target shape; a real DIR has to move. Anything
// else (missing, a dangling symlink) is not a repo this step can act on.
const gitEntryKind = async (repoDir: string): Promise<"dir" | "file" | undefined> => {
    const stats = await lstat(join(repoDir, ".git")).catch(() => undefined);
    if (stats === undefined) {
        return undefined;
    }
    return stats.isDirectory() ? "dir" : "file";
};

const relocateOne = async (
    repo: string,
    workspace: WorkspacePaths,
    historyRoot: string,
    logger: Logger,
    git: GitRunner,
): Promise<void> => {
    const repoDir = join(workspace.root, repo);
    if ((await gitEntryKind(repoDir)) !== "dir") {
        return;
    }
    const target = repoGitDir(historyRoot, repo);
    if ((await lstat(target).catch(() => undefined)) !== undefined) {
        // A git dir is already parked there for this id — moving onto it would destroy whichever one is real.
        // The repo keeps working exactly as it does today; only namespace isolation is unavailable for it.
        logger.warn({ repo, target }, "git dirs: target already occupied, repo left with an in-tree git dir");
        return;
    }
    /* COPY-then-swap, not rename: /work and /history are separate mounts, so `rename` fails EXDEV even when
     * they sit on one device. The copy is what makes the step interruptible — a crash before the pointer is
     * written leaves the original .git untouched and authoritative, and the next boot simply finds the target
     * occupied. `dereference: false` keeps git's own symlinks intact. */
    const entry = join(repoDir, ".git");
    await cp(entry, target, { recursive: true, dereference: false });
    // The directory has to go before the pointer can take its name. From here to the writeFile the repo has no
    // git entry at all, so a failure restores the copy under the original name rather than leaving it headless.
    await rm(entry, { recursive: true, force: true });
    await writeFile(entry, `gitdir: ${target}\n`).catch(async (error: unknown) => {
        await cp(target, entry, { recursive: true, dereference: false });
        await rm(target, { recursive: true, force: true });
        throw error;
    });
    // A separate git dir has no implicit worktree — `--separate-git-dir` records this on the daemon's own
    // repos, and a hand-moved one has to be told the same thing or every command runs bare.
    await git(repoDir, ["config", "core.worktree", repoDir]);
    /* Every worktree of this repo holds a pointer into the OLD admin path, and the admin dirs hold a backlink
     * to each worktree. `worktree repair`, run from the main checkout, rewrites both sides for all of them —
     * the same call worktrees.ts::repairOne makes for a single conversation. Without it, every existing agent
     * conversation loses its checkout the moment the git dir moves. */
    await git(repoDir, ["worktree", "repair"]).catch((error: unknown) => logger.warn({ err: error, repo }, "git dirs: worktree repair failed"));
    logger.info({ repo, target }, "git dirs: relocated in-tree git dir off the workspace root");
};

// Converge every workspace repo onto an out-of-tree git dir. Best-effort per repo: one repo that cannot move
// must not stop the others, and must not stop the boot — it only loses isolation for itself.
export const ensureRepoGitDirs = async (
    workspace: WorkspacePaths,
    historyRoot: string,
    logger: Logger,
    git: GitRunner = defaultGit,
): Promise<void> => {
    for (const repo of await discoverRepos(workspace.root)) {
        await relocateOne(repo, workspace, historyRoot, logger, git).catch((error: unknown) =>
            logger.warn({ err: error, repo }, "git dirs: relocation failed, repo keeps its in-tree git dir"),
        );
    }
};
