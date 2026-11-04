import { copyFile, cp, lstat, mkdir, readdir, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import { defaultGit, type GitRunner, persistGitDurability } from "@intentic/base/git";
import type { Logger } from "pino";
import { gitDirOf } from "../../store/git/git-dir.js";
import { freeGitDirFor } from "../../workspace/layout/git-dir-owners.js";
import { repoGitDir } from "../../workspace/layout/git-layout.js";
import { discoverRepos } from "../../workspace/layout/repo-discovery.js";
import type { WorkspacePaths } from "../../workspace/workspace.js";

// No git dir lives under /work, so an isolated turn's worktree can stand in for the whole workspace root. Converges
// every repo onto this shape on each boot, and a repo that joins later before its first checkout (convergeJoinedRepo);
// a repo already converged costs nothing.

// Shape of this repo's `.git`: a file is already the target shape, a dir must move; anything else (missing, dangling
// symlink) is not handled here.
const gitEntryKind = async (repoDir: string): Promise<"dir" | "file" | undefined> => {
    const stats = await lstat(join(repoDir, ".git")).catch(undefinedIfMissing);
    if (stats === undefined) {
        return undefined;
    }
    return stats.isDirectory() ? "dir" : "file";
};

// `core.worktree` is an absolute path shared by every worktree; pinned to /work/<repo> it would misdirect an isolated
// turn's own worktree to the main checkout. Unset, git resolves the worktree relative to the caller instead.
const unpinWorktree = async (repoDir: string, git: GitRunner): Promise<void> => {
    // Exit 5 is the key already absent, the steady state; any other failure leaves the pin in place.
    await git(repoDir, ["config", "--unset", "core.worktree"]).catch((error: unknown) => {
        if ((error as { code?: unknown }).code !== 5) {
            throw error;
        }
    });
};

// core.bare lives in the git dir's shared config: true blocks the main checkout while linked worktrees still work,
// which hides it. Every repo here has a real directory, so `false` is always correct here.
const unbare = async (repoDir: string, git: GitRunner): Promise<void> => {
    // Exit 1 is the key absent, which already matches the default (false).
    const current = await git(repoDir, ["config", "--get", "core.bare"]).catch((error: unknown) => {
        if ((error as { code?: unknown }).code !== 1) {
            throw error;
        }
        return undefined;
    });
    if (current?.stdout.trim() !== "true") {
        return;
    }
    await git(repoDir, ["config", "core.bare", "false"]);
};

// GIT_GLOBAL_ARGS' core.fileMode=false written into the shared config, where init/clone put `true` on Linux: a terminal's
// git must read the tree as the daemon does, or a synced executable bit is an edit only it sees and it refuses to pull.
// `--local`, since the daemon's own `-c` would otherwise answer the read.
export const ignoreFileMode = async (repoDir: string, git: GitRunner = defaultGit): Promise<void> => {
    const current = await git(repoDir, ["config", "--local", "--get", "core.fileMode"]).catch(() => undefined);
    if (current?.stdout.trim() === "false") {
        return;
    }
    await git(repoDir, ["config", "--local", "core.fileMode", "false"]);
};

// Where an in-tree git dir waits while its copy is brought level, beside the checkout it belongs to (same mount, so the
// rename in and back out is atomic). Found on a later pass, it says a relocation was cut short (recoverAside).
const ASIDE = ".git-relocating";

// Paths git names by their content (loose objects, packs, LFS objects): one already present at the same size is the
// same file. Everything else in a git dir (refs, HEAD, index, logs, config) can be rewritten in place.
const IMMUTABLE = /(^|\/)objects\/(?!info\/)/u;

// One link in `to` made to read as `from`'s does.
const syncLink = async (src: string, dst: string, have: Stats | undefined): Promise<void> => {
    const link = await readlink(src);
    if (have?.isSymbolicLink() === true && (await readlink(dst)) === link) {
        return;
    }
    await rm(dst, { recursive: true, force: true });
    await symlink(link, dst);
};

// One file in `to` made to read as `from`'s does; an object already there at its size is that object.
const syncFile = async (src: string, dst: string, path: string, want: Stats, have: Stats | undefined): Promise<void> => {
    if (IMMUTABLE.test(path) && have?.isFile() === true && have.size === want.size) {
        return;
    }
    if (have?.isDirectory() === true) {
        await rm(dst, { recursive: true, force: true });
    }
    await copyFile(src, dst);
};

// Brings `to`, a copy of `from` made while the repo was live, level with it: what was written since (a commit's
// objects and ref, the index) is copied again and what went (a lock released, refs packed) is removed. The object store
// is a walk of stats rather than a second copy.
const syncTree = async (from: string, to: string, rel = ""): Promise<void> => {
    const source = await readdir(from, { withFileTypes: true });
    const names = new Set(source.map((entry) => entry.name));
    const stale = ((await readdir(to).catch(undefinedIfMissing)) ?? []).filter((name) => !names.has(name));
    await Promise.all(stale.map((name) => rm(join(to, name), { recursive: true, force: true })));
    for (const entry of source) {
        const src = join(from, entry.name);
        const dst = join(to, entry.name);
        const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
        const [want, have] = await Promise.all([lstat(src), lstat(dst).catch(undefinedIfMissing)]);
        if (!want.isDirectory()) {
            await (want.isSymbolicLink() ? syncLink(src, dst, have) : syncFile(src, dst, path, want, have));
            continue;
        }
        if (have?.isDirectory() !== true) {
            await rm(dst, { force: true });
            await mkdir(dst);
        }
        await syncTree(src, dst, path);
    }
};

// A relocation the daemon did not live to finish: the copy already took the pointer's place (only the aside is left
// to drop), or it did not, and the original goes back under its own name.
const recoverAside = async (repoDir: string, repo: string, logger: Logger): Promise<void> => {
    const aside = join(repoDir, ASIDE);
    if ((await lstat(aside).catch(undefinedIfMissing)) === undefined) {
        return;
    }
    const entry = join(repoDir, ".git");
    const kind = await gitEntryKind(repoDir);
    // Beside an in-tree git dir it is nothing this module set aside, so it is not this module's to remove or restore.
    if (kind === "dir") {
        logger.warn({ repo, aside }, "git dirs: a stray aside beside an in-tree git dir, left as it is");
        return;
    }
    // The copy already renamed into place: the pointer resolves, and only the aside is left to drop.
    if (kind === "file" && (await gitDirOf(repoDir)) !== undefined) {
        await rm(aside, { recursive: true, force: true });
        return;
    }
    await rm(entry, { force: true });
    await rename(aside, entry);
    logger.warn({ repo }, "git dirs: an interrupted relocation was undone, the repo has its in-tree git dir back");
};

// Every linked checkout re-pointed at the moved git dir's admin dirs. `worktree repair` alone has been seen to exit 0
// and still leave one pointing at the old place, so each is named to it, then read back and written by hand if not.
const repointWorktrees = async (repoDir: string, target: string, repo: string, logger: Logger, git: GitRunner): Promise<void> => {
    const admins = join(target, "worktrees");
    const checkouts: { checkout: string; admin: string }[] = [];
    for (const name of (await readdir(admins).catch(undefinedIfMissing)) ?? []) {
        // The admin dir's backlink names the checkout's `.git`; one already gone is left for `worktree prune`.
        const back = (await readFile(join(admins, name, "gitdir"), "utf8").catch(undefinedIfMissing))?.trim();
        const pointer = back === undefined || back === "" ? undefined : resolve(admins, name, back);
        if (pointer !== undefined && (await lstat(pointer).catch(undefinedIfMissing))?.isFile() === true) {
            checkouts.push({ checkout: dirname(pointer), admin: join(admins, name) });
        }
    }
    await git(repoDir, ["worktree", "repair", ...checkouts.map(({ checkout }) => checkout)]).catch((err) =>
        logger.warn({ err, repo }, "git dirs: worktree repair failed"),
    );
    for (const { checkout, admin } of checkouts) {
        if ((await gitDirOf(checkout)) !== admin) {
            await writeFile(join(checkout, ".git"), `gitdir: ${admin}\n`).catch((err) =>
                logger.warn({ err, repo, checkout }, "git dirs: a linked checkout still points at the old git dir"),
            );
        }
    }
};

// Moves the repo's in-tree git dir to /history/gits/<repo>, safe while git is writing in it (the daemon calls this at
// runtime too, for a repo that joined after boot). Copies first while the repo is live, then sets the original aside
// and puts the pointer in its place (a git started now fails "not a git repository" rather than writing to a dir about
// to go, or walking up into the root repo), brings the copy level with whatever landed during the copy, and renames it
// into place. A failure before that rename puts the original back untouched.
const relocateOne = async (repo: string, repos: readonly string[], workspace: WorkspacePaths, historyRoot: string, logger: Logger, git: GitRunner): Promise<void> => {
    const repoDir = join(workspace.root, repo);
    await recoverAside(repoDir, repo, logger);
    if ((await gitEntryKind(repoDir)) !== "dir") {
        return;
    }
    const target = repoGitDir(historyRoot, repo);
    // A dir an earlier folder of this name left (the repo was deleted and cloned again) goes to the trash when nothing
    // leads to it any more; one another checkout still uses stays, and this repo keeps its in-tree git dir.
    const user = await freeGitDirFor({ workspaceRoot: workspace.root, historyRoot, logger }, repos, repo);
    if (user !== undefined || (await lstat(target).catch(undefinedIfMissing)) !== undefined) {
        logger.warn({ repo, target, user }, "git dirs: target already occupied, repo left with an in-tree git dir");
        return;
    }
    const entry = join(repoDir, ".git");
    const aside = join(repoDir, ASIDE);
    // Copied, not renamed: /work and /history are separate mounts (rename fails EXDEV). Staged in the trash on the
    // target's own mount, so the last step is an atomic rename and a crash leaves only something the sweep reclaims.
    const staging = join(historyRoot, "trash", `${encodeURIComponent(repo)}-relocating-${Date.now()}`);
    await mkdir(dirname(staging), { recursive: true });
    await mkdir(dirname(target), { recursive: true });
    try {
        // `dereference: false` preserves git's own symlinks.
        await cp(entry, staging, { recursive: true, dereference: false });
        await rename(entry, aside);
        try {
            await writeFile(entry, `gitdir: ${target}\n`);
            await syncTree(aside, staging);
            await rename(staging, target);
        } catch (error) {
            await rm(entry, { force: true });
            await rename(aside, entry);
            throw error;
        }
    } finally {
        await rm(staging, { recursive: true, force: true });
    }
    await rm(aside, { recursive: true, force: true }).catch((err) =>
        logger.warn({ err, repo }, "git dirs: could not remove the old in-tree git dir"),
    );
    await repointWorktrees(repoDir, target, repo, logger, git);
    logger.info({ repo, target }, "git dirs: relocated in-tree git dir off the workspace root");
};

// One repo brought to the shape below. Best-effort: each step's failure is said and costs only that step.
const convergeRepo = async (
    repo: string,
    repos: readonly string[],
    workspace: WorkspacePaths,
    historyRoot: string,
    logger: Logger,
    git: GitRunner,
): Promise<void> => {
    await relocateOne(repo, repos, workspace, historyRoot, logger, git).catch((err) =>
        logger.warn({ err, repo }, "git dirs: relocation failed, repo keeps its in-tree git dir"),
    );
    await unpinWorktree(join(workspace.root, repo), git).catch((err) =>
        logger.warn({ err, repo }, "git dirs: could not unpin core.worktree, an isolated turn's checkout may resolve to the main one"),
    );
    await unbare(join(workspace.root, repo), git).catch((err) =>
        logger.warn({ err, repo }, "git dirs: could not clear core.bare, the main checkout stays unreadable to git"),
    );
    await ignoreFileMode(join(workspace.root, repo), git).catch((err) =>
        logger.warn({ err, repo }, "git dirs: could not persist core.fileMode=false, a terminal's git may see mode-only edits"),
    );
    await persistGitDurability(join(workspace.root, repo), git).catch((err) =>
        logger.warn({ err, repo }, "git dirs: could not persist core.fsync, a terminal's git writes may not survive a host crash"),
    );
};

// A repo that appeared after boot (`git init`, `git clone`, a copy) converged as boot would have, before a conversation
// links a checkout to it: a worktree added over an in-tree git dir records `/work/<repo>/.git/worktrees/...`, which
// names nothing inside an isolated turn. The caller holds the repo's lock, so none of the daemon's own git runs in it
// meanwhile. A single lstat for a repo already converged.
export const convergeJoinedRepo = async (
    workspace: WorkspacePaths,
    historyRoot: string,
    logger: Logger,
    repo: string,
    git: GitRunner = defaultGit,
): Promise<void> => {
    if (repo === "root") {
        return;
    }
    const repoDir = join(workspace.root, repo);
    if ((await gitEntryKind(repoDir)) !== "dir" && (await lstat(join(repoDir, ASIDE)).catch(undefinedIfMissing)) === undefined) {
        return;
    }
    await convergeRepo(repo, await discoverRepos(workspace.root), workspace, historyRoot, logger, git);
};

// Converges every repo onto an out-of-tree git dir, unpinned, non-bare, mode-blind, and syncing its writes to disk. Best-effort: one repo's failure
// costs only its own isolation, never the boot; repairs run on every repo so a stale pin can't persist.
export const ensureRepoGitDirs = async (
    workspace: WorkspacePaths,
    historyRoot: string,
    logger: Logger,
    git: GitRunner = defaultGit,
): Promise<void> => {
    const repos = await discoverRepos(workspace.root);
    for (const repo of repos) {
        await convergeRepo(repo, repos, workspace, historyRoot, logger, git);
    }
};
