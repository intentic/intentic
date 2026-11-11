import { lstat, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import { writeFileAtomic } from "@intentic/base/fs";
import type { GitRunner } from "@intentic/base/git";
import type { Logger } from "pino";
import { commonDirOf, gitDirOf, headBranchIn } from "../../store/git/git-dir.js";
import { ROOT_REPO } from "./repo-discovery.js";

/* THE LINKS BETWEEN A REPOSITORY AND ITS WORKTREES, KEPT ONE PAIR AT A TIME (2026-11-11). Each linked worktree is two
   files that name each other: the checkout's `.git` (`gitdir: <admin>`) and the admin dir's `gitdir` (`<checkout>/.git`).
   `git worktree repair` trusts every admin's `gitdir` and rewrites the `.git` file it names, for every worktree at once,
   whatever path it is given. So one admin naming a shared checkout turns the next repair anywhere in that repository
   into a hijack of it.

   That happened in a sandbox with private conversations (targowisko, Nov 9-11). In the privacy jail a conversation's
   checkout is mounted at the workspace root while the git dirs stay writable at their real path (turn-sandbox.ts
   jailCheckoutArgs), so git run inside recorded the shared checkout's own `.git` as the home conversation's worktree. The
   daemon's next relink of another conversation ran `worktree repair`, which re-pointed that shared `.git` into the
   worktree's admin dir. The
   shared checkout then stood on `agent/home-…`, every land waited on it, and "Back to main" could only fail.

   So the daemon never runs `worktree repair` (linkOne writes the one pair it means), and healSharedCheckoutLinks undoes
   the hijack where it happened anyway: an admin naming a repository's shared checkout gets its real checkout back (or a
   path nothing stands at, which reads as prunable), then a shared checkout pointing into an admin dir is pointed back at
   its repository. File contents and indexes are never touched. */

// Where a sandbox keeps its checkouts: the shared ones under the workspace root, each conversation's beside them.
export interface LinkLayout {
    readonly mainDir: (repo: string) => string;
    readonly worktreeDir: (id: string, repo: string) => string;
    readonly conversationDir: (id: string) => string;
}

/** The layout of a workspace at `workspaceRoot` with conversations' checkouts under `worktreesRoot` (worktrees.ts). */
export const linkLayoutOf = (workspaceRoot: string, worktreesRoot: string): LinkLayout => ({
    mainDir: (repo) => (repo === ROOT_REPO ? workspaceRoot : join(workspaceRoot, repo)),
    worktreeDir: (id, repo) => (repo === ROOT_REPO ? join(worktreesRoot, id) : join(worktreesRoot, id, repo)),
    conversationDir: (id) => join(worktreesRoot, id),
});

/** Refused before anything is written: the checkout named is one every agent lands into. */
export class SharedCheckoutLinkError extends Error {
    constructor(readonly checkout: string) {
        super(`refused to link a worktree to the shared checkout ${checkout}: it is its repository's main checkout`);
        this.name = "SharedCheckoutLinkError";
    }
}

// The checkout an admin dir's `gitdir` names (the dir holding the `.git` it lists), undefined when it names none.
const backlinkOf = async (admin: string): Promise<string | undefined> => {
    const named = ((await readFile(join(admin, "gitdir"), "utf8").catch(undefinedIfMissing)) ?? "").trim();
    return named === "" ? undefined : dirname(resolve(admin, named));
};

/**
 * Points one admin dir and one checkout at each other and touches nothing else, which `git worktree repair` cannot
 * promise. Throws SharedCheckoutLinkError, writing nothing, when `checkout` is one of `shared`.
 */
export const linkOne = async (admin: string, checkout: string, shared: readonly string[]): Promise<void> => {
    if (shared.some((dir) => resolve(dir) === resolve(checkout))) {
        throw new SharedCheckoutLinkError(checkout);
    }
    await writeFileAtomic(join(admin, "gitdir"), `${join(resolve(checkout), ".git")}\n`);
    await writeFileAtomic(join(checkout, ".git"), `gitdir: ${resolve(admin)}\n`);
};

/** The admin dir main keeps for a checkout at `target`, found by its backlink; undefined once pruned. */
export const adminFor = async (main: string, target: string): Promise<string | undefined> => {
    const gitDir = await gitDirOf(main);
    if (gitDir === undefined) {
        return undefined;
    }
    const common = await commonDirOf(gitDir);
    // allow(silent-catch): an unresolvable link keeps the path as named, as every other read of the common dir does.
    const admins = join(await realpath(common).catch(() => common), "worktrees");
    for (const name of (await readdir(admins).catch(undefinedIfMissing)) ?? []) {
        if ((await backlinkOf(join(admins, name))) === resolve(target)) {
            return join(admins, name);
        }
    }
    return undefined;
};

/**
 * An admin dir for `target` that main does not know yet: `worktree add` into a scratch dir of the same name (never over
 * the checkout, whose files are the agent's work), for linkOne to join to the checkout. Throws when git refuses (the
 * branch is checked out elsewhere), before the checkout is touched.
 */
export const freshAdminFor = async (main: string, target: string, branch: string, git: GitRunner): Promise<string> => {
    // allow(silent-catch): pruning stale records is optional; the add below reports its own failure.
    await git(main, ["worktree", "prune"]).catch(() => undefined);
    const scratch = await mkdtemp(join(tmpdir(), "intentic-relink-"));
    try {
        const staging = join(scratch, basename(target));
        await git(main, ["worktree", "add", "--no-checkout", staging, branch]);
        const admin = await pointerOf(staging);
        if (admin === undefined) {
            throw new Error(`git worktree add left no pointer at ${staging}`);
        }
        return admin;
    } finally {
        await rm(scratch, { recursive: true, force: true });
    }
};

/**
 * After a repository's git dir moved, each linked checkout pointed at its admin dir's new place, as `worktree repair`
 * would have done, but never a shared one: an admin naming a shared checkout is left for the heal and said.
 */
export const repointLinkedCheckouts = async (common: string, shared: readonly string[], logger: Logger, repo: string): Promise<void> => {
    const admins = join(common, "worktrees");
    for (const name of (await readdir(admins).catch(undefinedIfMissing)) ?? []) {
        const admin = join(admins, name);
        const checkout = await backlinkOf(admin);
        // Only a checkout whose `.git` is a pointer file; one already gone is left for `worktree prune`.
        if (checkout === undefined || (await lstat(join(checkout, ".git")).catch(undefinedIfMissing))?.isFile() !== true) {
            continue;
        }
        if (shared.some((dir) => resolve(dir) === checkout)) {
            logger.warn({ repo, admin, checkout }, "git dirs: a worktree record names a shared checkout, left for the heal");
            continue;
        }
        if ((await gitDirOf(checkout)) !== admin) {
            try {
                await writeFileAtomic(join(checkout, ".git"), `gitdir: ${admin}\n`);
            } catch (error) {
                logger.warn({ err: error, repo, checkout }, "git dirs: a linked checkout still points at the old git dir");
            }
        }
    }
};

// The `.git` pointer file of a checkout, resolved, undefined for an in-tree `.git` dir or none.
const pointerOf = async (checkout: string): Promise<string | undefined> => {
    // allow(silent-catch): no `.git`, or a `.git` dir, is no pointer, which is the answer asked for.
    const named = (await readFile(join(checkout, ".git"), "utf8").catch(() => "")).match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
    return named === undefined || named === "" ? undefined : resolve(checkout, named);
};

// Which conversation's checkout leads into `admin`: the one its branch names first (`agent/<id>`), else any under the
// conversations' root. Undefined when none does.
const ownerOf = async (layout: LinkLayout, repo: string, admin: string): Promise<string | undefined> => {
    const branch = await headBranchIn(admin);
    const named = branch?.startsWith("agent/") === true ? layout.worktreeDir(branch.slice("agent/".length), repo) : undefined;
    if (named !== undefined && (await pointerOf(named)) === admin) {
        return named;
    }
    const root = dirname(layout.conversationDir("_"));
    for (const id of (await readdir(root).catch(undefinedIfMissing)) ?? []) {
        const candidate = layout.worktreeDir(id, repo);
        if (candidate !== named && (await pointerOf(candidate)) === admin) {
            return candidate;
        }
    }
    return undefined;
};

/**
 * Detaches, in place, every linked worktree of `main`'s repository that has `branch` checked out, so the shared
 * checkout can take it back: `switch --detach` moves no file and no index entry, and the commits stay where they are.
 * Answers the checkouts it detached; one git cannot reach is said and left.
 */
export const releaseBranch = async (main: string, branch: string, logger: Logger, git: GitRunner): Promise<string[]> => {
    const { stdout } = await git(main, ["worktree", "list", "--porcelain"]);
    // The first entry is the repository's main worktree, which is the shared checkout itself.
    const holders = stdout
        .split("\n\n")
        .slice(1)
        .filter((entry) => entry.split("\n").includes(`branch refs/heads/${branch}`))
        .flatMap((entry) => /^worktree (.+)$/m.exec(entry)?.[1] ?? [])
        .filter((path) => resolve(path) !== resolve(main));
    const released: string[] = [];
    for (const path of holders) {
        try {
            await git(path, ["switch", "--detach", "-q"]);
            released.push(path);
            logger.warn({ checkout: path, branch }, "git links: a conversation's checkout held the main line, detached in place");
        } catch (error) {
            logger.warn({ err: error, checkout: path, branch }, "git links: could not detach a checkout holding the main line");
        }
    }
    return released;
};

/** One repair the heal made, for its log line and its caller. */
export interface LinkHeal {
    readonly repo: string;
    readonly kind: "worktree-record" | "shared-checkout";
    readonly path: string;
    readonly from: string;
    readonly to: string;
}

/**
 * Undoes a shared checkout's hijack in each of `repos` (`root` included when listed): first every worktree record of
 * the repository that names the shared checkout is given its own checkout back, so no later repair re-points it, then
 * a shared checkout whose `.git` leads into a worktree's admin dir is pointed back at the repository. Answers what it
 * changed; a repo that cannot be read is skipped and said.
 */
export const healSharedCheckoutLinks = async (layout: LinkLayout, repos: readonly string[], logger: Logger): Promise<LinkHeal[]> => {
    const healed: LinkHeal[] = [];
    for (const repo of repos) {
        const main = layout.mainDir(repo);
        try {
            const gitDir = await gitDirOf(main);
            if (gitDir === undefined) {
                continue;
            }
            const common = resolve(await commonDirOf(gitDir));
            // Only a checkout of its own repository (`gits/<repo>`, as the workspace makes them): a folder holding a
            // worktree of another one (`git worktree add <workspace>/app-feature`) is a person's, and stays as they made it.
            if (basename(common) !== encodeURIComponent(repo)) {
                continue;
            }
            const admins = join(common, "worktrees");
            for (const name of (await readdir(admins).catch(undefinedIfMissing)) ?? []) {
                const admin = join(admins, name);
                if ((await backlinkOf(admin)) !== resolve(main)) {
                    continue;
                }
                const owner = await ownerOf(layout, repo, admin);
                // Nothing leads into it: a path nothing stands at, so git reads it as prunable rather than as the shared checkout.
                const to = owner ?? join(admin, "orphaned-checkout");
                await writeFileAtomic(join(admin, "gitdir"), `${join(to, ".git")}\n`);
                healed.push({ repo, kind: "worktree-record", path: admin, from: main, to });
            }
            if (resolve(gitDir) !== common) {
                await writeFileAtomic(join(main, ".git"), `gitdir: ${common}\n`);
                healed.push({ repo, kind: "shared-checkout", path: main, from: gitDir, to: common });
            }
        } catch (error) {
            logger.warn({ err: error, repo }, "git links: could not check a shared checkout's links");
        }
    }
    for (const heal of healed) {
        logger.warn(
            heal,
            heal.kind === "shared-checkout"
                ? "git links: a shared checkout was linked into a worktree's record, pointed back at its repository"
                : "git links: a worktree record named a shared checkout, given its own checkout back",
        );
    }
    return healed;
};
