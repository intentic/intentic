import { readFile, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathExists } from "@intentic/base/fs";
import { undefinedIfMissing } from "@intentic/base/errors";

// Where a checkout's git admin files live, read straight off the filesystem so a hot path pays no spawn. A linked
// worktree or submodule has a `.git` pointer file; its per-worktree dir holds HEAD and operation markers, and the common
// dir (named by `commondir`) holds refs and the shared `config`.

// The per-worktree admin dir: `.git` itself, or the pointer's target resolved against the checkout; undefined when
// neither resolves to something on disk (not a repo, or a torn pointer whose repository is gone).
export const gitDirOf = async (checkout: string): Promise<string | undefined> => {
    const entry = join(checkout, ".git");
    const stats = await stat(entry).catch(undefinedIfMissing);
    if (stats === undefined) {
        return undefined;
    }
    if (stats.isDirectory()) {
        return entry;
    }
    // allow(silent-catch): an unreadable pointer has always meant no usable checkout to this filesystem probe.
    const named = (await readFile(entry, "utf8").catch(() => "")).match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
    const gitDir = named === undefined || named === "" ? undefined : resolve(checkout, named);
    return gitDir !== undefined && (await pathExists(gitDir)) ? gitDir : undefined;
};

// The repository a checkout's `.git` reaches, as its common dir with symlinks resolved, so two checkouts of one
// repository answer alike; undefined when it reaches none.
export const repositoryOf = async (checkout: string): Promise<string | undefined> => {
    const gitDir = await gitDirOf(checkout);
    return gitDir === undefined ? undefined : realpath(await commonDirOf(gitDir)).catch(undefinedIfMissing);
};

// Which branch an admin dir's HEAD names, undefined for a detached HEAD, which is not a branch. Taking the admin dir
// lets a caller that already has it tell a detached HEAD from no checkout, which the branch alone cannot say.
export const headBranchIn = async (gitDir: string): Promise<string | undefined> =>
    ((await readFile(join(gitDir, "HEAD"), "utf8").catch(undefinedIfMissing)) ?? ``).match(/^ref:\s*refs\/heads\/(\S+)$/m)?.[1];

// Which branch a checkout is on, off the files rather than through git, so a hot path pays no spawn; undefined when
// there is no checkout or it is detached.
export const checkedOutBranch = async (checkout: string): Promise<string | undefined> => {
    const gitDir = await gitDirOf(checkout);
    return gitDir === undefined ? undefined : headBranchIn(gitDir);
};

// The common dir behind an admin dir: `commondir`'s target resolved against the admin dir, or the admin dir itself
// when it has none (a main checkout, a submodule).
export const commonDirOf = async (gitDir: string): Promise<string> => {
    // allow(silent-catch): preserve the probe's fallback to the admin directory when no common directory can be read.
    const named = (await readFile(join(gitDir, "commondir"), "utf8").catch(() => "")).trim();
    return named === "" ? gitDir : resolve(gitDir, named);
};
