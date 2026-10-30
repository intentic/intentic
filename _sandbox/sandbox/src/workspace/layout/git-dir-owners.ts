import { cp, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import { pathExists } from "@intentic/base/fs";
import { defaultGit, type GitRunner } from "@intentic/base/git";
import type { Logger } from "pino";
import { repoGitDir } from "./git-layout.js";

/* WHO A GIT DIR ON /history BELONGS TO. Every repo's real git dir sits at /history/gits/<its folder's path>, and the
   folder holds a `.git` pointer to it. That name is where the dir was made, not who uses it: a copied folder carries
   the same pointer, a renamed one keeps pointing at its old name, a `git worktree add` beside it links into it, and a
   folder deleted from the file view and brought back with Undo points at a dir the reaper already moved to the trash.

   Going by the name alone, the reaper saw the folder of that name gone and moved the dir away while another checkout still
   led into it, and that checkout's git stopped working: `fatal: not a git repository: /history/gits/<name>`, its remote
   with it (2026-10, a repository cloned twice into one workspace, then one of the two removed). So the dirs are read
   by what points at them. Each history cycle, before anything is reaped:

   - a pointer whose dir is in /history/trash brings it back;
   - a checkout pointing at another folder's dir is a copy while that folder still uses the dir, and gets a copy of its
     own (two checkouts on one index and HEAD move each other's branches), or a move once nobody else does, and takes
     the dir under its own name;
   - a dir that any checkout under /work still leads into is never reaped.

   A dir is renamed or copied only into a name nothing holds or leads to; one that something does is left, and said. */

const gitsRoot = (historyRoot: string): string => join(historyRoot, "gits");
const trashRoot = (historyRoot: string): string => join(historyRoot, "trash");

// One checkout's `.git` pointer into /history/gits: the entry (URI-encoded repo id) it leads to, and whether it is a
// linked worktree's (`gits/<entry>/worktrees/<name>`) rather than the main checkout's (`gits/<entry>`).
export interface GitDirPointer {
    readonly repo: string;
    readonly entry: string;
    readonly linked: boolean;
}

// The entry a pointer target names, if it is one of the shapes git leaves under gits/; anything else (a dir outside
// /history, a submodule's `modules/` dir) is not this module's to move.
const entryOf = (historyRoot: string, target: string): { entry: string; linked: boolean } | undefined => {
    const rel = relative(gitsRoot(historyRoot), target);
    const parts = rel.split(sep);
    const [entry] = parts;
    if (entry === undefined || entry === "" || entry === ".." || entry === "root" || rel.startsWith(`..${sep}`)) {
        return undefined;
    }
    if (parts.length === 1) {
        return { entry, linked: false };
    }
    return parts.length === 3 && parts[1] === "worktrees" ? { entry, linked: true } : undefined;
};

// Where a checkout's `.git` file leads, resolved against the checkout; undefined for an in-tree `.git` dir, a missing
// one, or a file that names no dir.
const pointerTarget = async (checkout: string): Promise<string | undefined> => {
    const entry = join(checkout, ".git");
    const stats = await lstat(entry).catch(undefinedIfMissing);
    if (stats === undefined || !stats.isFile()) {
        return undefined;
    }
    const named = (await readFile(entry, "utf8").catch(undefinedIfMissing))?.match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
    return named === undefined || named === "" ? undefined : resolve(checkout, named);
};

// Every discovered checkout's pointer into /history/gits, whether or not its dir is there.
const gitDirPointers = async (workspaceRoot: string, historyRoot: string, repos: readonly string[]): Promise<GitDirPointer[]> => {
    const read = await Promise.all(
        repos.map(async (repo): Promise<GitDirPointer | undefined> => {
            const target = await pointerTarget(join(workspaceRoot, repo));
            const named = target === undefined ? undefined : entryOf(historyRoot, target);
            return named === undefined ? undefined : { repo, ...named };
        }),
    );
    return read.filter((pointer) => pointer !== undefined);
};

// The checkouts that lead into `entry`, leaving out the folder of that name when it is the one asking.
export const checkoutsOf = (pointers: readonly GitDirPointer[], entry: string, except?: string): GitDirPointer[] =>
    pointers.filter((pointer) => pointer.entry === entry && pointer.repo !== except);

// Moves a git dir nothing uses to <historyRoot>/trash rather than erasing it: it may hold commits no remote has.
export const reapGitDir = async (historyRoot: string, entry: string, logger: Logger, reason: string): Promise<void> => {
    await mkdir(trashRoot(historyRoot), { recursive: true });
    await rename(join(gitsRoot(historyRoot), entry), join(trashRoot(historyRoot), `${entry}-${Date.now()}`));
    logger.info({ repo: decodeURIComponent(entry), reason }, "history: reaped a deleted repo's git dir");
};

// The newest dir reapGitDir left for `entry` (`<entry>-<ms>`), undefined when there is none.
const newestTrashed = async (historyRoot: string, entry: string): Promise<string | undefined> => {
    const names = (await readdir(trashRoot(historyRoot)).catch(undefinedIfMissing)) ?? [];
    const stamped = names.flatMap((name) => {
        const cut = name.lastIndexOf("-");
        const stamp = name.slice(cut + 1);
        return cut > 0 && name.slice(0, cut) === entry && /^\d+$/.test(stamp) ? [{ name, at: Number(stamp) }] : [];
    });
    return stamped.toSorted((a, b) => b.at - a.at)[0]?.name;
};

// Brings each git dir a checkout still points at back out of the trash; answers whether any came back.
const reviveTrashed = async (historyRoot: string, pointers: readonly GitDirPointer[], logger: Logger): Promise<boolean> => {
    let revived = false;
    for (const entry of new Set(pointers.map((pointer) => pointer.entry))) {
        if (await pathExists(join(gitsRoot(historyRoot), entry))) {
            continue;
        }
        const trashed = await newestTrashed(historyRoot, entry);
        if (trashed === undefined) {
            continue;
        }
        await rename(join(trashRoot(historyRoot), trashed), join(gitsRoot(historyRoot), entry));
        revived = true;
        logger.info({ repo: decodeURIComponent(entry), for: checkoutsOf(pointers, entry).map((pointer) => pointer.repo) }, "git dirs: brought a repo's git dir back from the trash, a checkout still points at it");
    }
    return revived;
};

const writePointer = async (workspaceRoot: string, repo: string, gitDir: string): Promise<void> => {
    await writeFile(join(workspaceRoot, repo, ".git"), `gitdir: ${gitDir}\n`);
};

export interface GitDirConvergence {
    readonly workspaceRoot: string;
    readonly historyRoot: string;
    readonly logger: Logger;
    readonly git?: GitRunner;
    // Names whose blocked convergence was already said, so a standing one is not logged again every cycle.
    readonly said?: Set<string>;
}

// Frees `repo`'s own name under gits/ for it: true when nothing is there, or what is there nothing leads to (then
// trashed); false when another checkout still uses it, which leaves this checkout where it is.
const claimOwnName = async (deps: GitDirConvergence, pointers: readonly GitDirPointer[], repo: string): Promise<boolean> => {
    const own = encodeURIComponent(repo);
    if (!(await pathExists(repoGitDir(deps.historyRoot, repo)))) {
        return true;
    }
    const users = checkoutsOf(pointers, own);
    if (users.length > 0) {
        if (!deps.said?.has(repo)) {
            deps.said?.add(repo);
            deps.logger.warn({ repo, users: users.map((user) => user.repo) }, "git dirs: a checkout's own name is held by another checkout's git dir, left pointing where it does");
        }
        return false;
    }
    await reapGitDir(deps.historyRoot, own, deps.logger, "its folder now holds another repository");
    return true;
};

// A copy of `entry`'s dir for `repo`, without the linked worktrees' admin dirs: those belong to the original, and a
// second registration would make git refuse their branches here.
const copyFor = async (deps: GitDirConvergence, entry: string, repo: string): Promise<void> => {
    const from = join(gitsRoot(deps.historyRoot), entry);
    const to = repoGitDir(deps.historyRoot, repo);
    const worktrees = join(from, "worktrees");
    try {
        await cp(from, to, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true, filter: (path) => path !== worktrees });
    } catch (failure) {
        await rm(to, { recursive: true, force: true });
        throw failure;
    }
    await writePointer(deps.workspaceRoot, repo, to);
    deps.logger.info({ repo, from: decodeURIComponent(entry) }, "git dirs: a copied checkout got a git dir of its own");
};

// `entry`'s dir renamed to `repo`'s name, the checkout re-pointed, and every linked worktree's link back repaired.
const moveTo = async (deps: GitDirConvergence, entry: string, repo: string): Promise<void> => {
    const to = repoGitDir(deps.historyRoot, repo);
    await rename(join(gitsRoot(deps.historyRoot), entry), to);
    await writePointer(deps.workspaceRoot, repo, to);
    try {
        await (deps.git ?? defaultGit)(join(deps.workspaceRoot, repo), ["worktree", "repair"]);
    } catch (error) {
        deps.logger.warn({ err: error, repo }, "git dirs: worktree repair after a move failed");
    }
    deps.logger.info({ repo, from: decodeURIComponent(entry) }, "git dirs: a moved checkout took its git dir along");
};

// One entry's main checkouts under other names: every one but the heir gets a copy, then the heir takes the dir when
// the folder it was named for no longer uses it. Answers whether anything moved.
const convergeEntry = async (deps: GitDirConvergence, pointers: readonly GitDirPointer[], entry: string): Promise<boolean> => {
    const owner = decodeURIComponent(entry);
    const mains = pointers.filter((pointer) => pointer.entry === entry && !pointer.linked).map((pointer) => pointer.repo);
    const strays = mains.filter((repo) => repo !== owner).toSorted();
    const heir = mains.includes(owner) ? undefined : strays[0];
    let moved = false;
    for (const repo of strays) {
        if (repo === heir || !(await claimOwnName(deps, pointers, repo))) {
            continue;
        }
        await copyFor(deps, entry, repo);
        moved = true;
    }
    if (heir !== undefined && (await claimOwnName(deps, pointers, heir))) {
        await moveTo(deps, entry, heir);
        moved = true;
    }
    return moved;
};

// Each cycle's convergence over the discovered checkouts, before anything is reaped: trashed dirs a pointer names come
// back, copies and moves get their own names. Answers the pointers as they stand afterwards, and whether any changed.
export const convergeGitDirs = async (deps: GitDirConvergence, repos: readonly string[]): Promise<{ pointers: GitDirPointer[]; changed: boolean }> => {
    const read = (): Promise<GitDirPointer[]> => gitDirPointers(deps.workspaceRoot, deps.historyRoot, repos);
    let pointers = await read();
    let changed = await reviveTrashed(deps.historyRoot, pointers, deps.logger);
    const foreign = new Set(pointers.filter((pointer) => !pointer.linked && pointer.entry !== encodeURIComponent(pointer.repo)).map((pointer) => pointer.entry));
    for (const entry of foreign) {
        if (!(await pathExists(join(gitsRoot(deps.historyRoot), entry)))) {
            continue;
        }
        try {
            changed = (await convergeEntry(deps, pointers, entry)) || changed;
        } catch (error) {
            deps.logger.warn({ err: error, repo: decodeURIComponent(entry) }, "git dirs: could not give a copied or moved checkout its own git dir");
        }
        pointers = await read();
    }
    return { pointers, changed };
};

// Makes `name`'s git dir free for a repository about to be cloned or created there: a dir left by an earlier folder of
// that name, which nothing leads to any more, goes to the trash (a clone would refuse it; an init would adopt its
// history as the new repository's). Answers the checkout still using it when one does, and then nothing moved.
export const freeGitDirFor = async (deps: GitDirConvergence, repos: readonly string[], name: string): Promise<string | undefined> => {
    if (!(await pathExists(repoGitDir(deps.historyRoot, name)))) {
        return undefined;
    }
    const entry = encodeURIComponent(name);
    const user = checkoutsOf(await gitDirPointers(deps.workspaceRoot, deps.historyRoot, repos), entry)[0];
    if (user !== undefined) {
        return user.repo;
    }
    await reapGitDir(deps.historyRoot, entry, deps.logger, "a new repository takes its name");
    return undefined;
};
