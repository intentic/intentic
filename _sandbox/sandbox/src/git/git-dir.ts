import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathExists } from "../path-exists.js";

// Where a checkout's git admin files live, read straight off the filesystem so a hot path pays no spawn. A linked
// worktree or submodule has a `.git` pointer file; its per-worktree dir holds HEAD and operation markers, and the common
// dir (named by `commondir`) holds refs and the shared `config`.

// The per-worktree admin dir: `.git` itself, or the pointer's target resolved against the checkout; undefined when
// neither resolves to something on disk (not a repo, or a torn pointer whose repository is gone).
export const gitDirOf = async (checkout: string): Promise<string | undefined> => {
    const entry = join(checkout, ".git");
    const stats = await stat(entry).catch(() => undefined);
    if (stats === undefined) {
        return undefined;
    }
    if (stats.isDirectory()) {
        return entry;
    }
    const named = (await readFile(entry, "utf8").catch(() => "")).match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
    const gitDir = named === undefined || named === "" ? undefined : resolve(checkout, named);
    return gitDir !== undefined && (await pathExists(gitDir)) ? gitDir : undefined;
};

// The common dir behind an admin dir: `commondir`'s target resolved against the admin dir, or the admin dir itself
// when it has none (a main checkout, a submodule).
export const commonDirOf = async (gitDir: string): Promise<string> => {
    const named = (await readFile(join(gitDir, "commondir"), "utf8").catch(() => "")).trim();
    return named === "" ? gitDir : resolve(gitDir, named);
};
