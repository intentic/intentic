import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { defaultGit, type GitRunner } from "@intentic/scaffold";

/* THE MANIFEST AND THE LOCKFILE LEAVE THE WORKTREE TOGETHER.
 *
 * Nine `fix: lock` commits in two weeks were the same event: an agent's turn edited a package.json, the land
 * carried that edit into the main tree, the daemon's reinstall rewrote pnpm-lock.yaml beside it, and the owner
 * committed the first without the second. Every gate in the worktree passed, because the suite reads the tree;
 * CI's checkout failed the lockfile check in its first minute. The push gate now refuses that push by name
 * (verify-push.mjs, the lockstep tier), which is the right verdict at the latest possible moment.
 *
 * The right moment is here: the land, before the worktree's remainder is committed, while the delta is still
 * one thing. A turn cannot install inside its worktree (an isolated turn's install is discarded, and a
 * shared-tree install races every other turn), so a manifest edit leaves the worktree with a lockfile that
 * no longer records it. `pnpm install --lockfile-only` writes the lockfile and nothing else, needs no
 * node_modules, and runs where the manifest is, so the two arrive in the same patch, the same commit draft
 * and the same push.
 *
 * ONLY WHEN THE DELTA ITSELF SAYS SO: a manifest changed and the lockfile did not, in the dirty tree or in the
 * commits since the last land. A delta that carries both is an agent that ran the install itself, and a delta
 * that carries neither has nothing to reconcile. Best-effort, like every other pre-land step: a resolution that
 * fails (no network, a specifier nothing publishes) leaves the tree exactly as it was and the lockstep gate at
 * the push still says what is missing. pnpm only, by the lockfile's name: it is the manager this workspace
 * uses, and a guessed command for another would be worse than none. */

export const LOCKFILE = "pnpm-lock.yaml";
const MANIFEST = /(^|\/)(package\.json|pnpm-workspace\.yaml)$/;
// A resolution reads the registry for whatever is new; three minutes is far past what one manifest edit costs.
const RESOLVE_TIMEOUT_MS = 180_000;

export type LockfileReconciliation = "current" | "regenerated" | "failed";

export type InstallRunner = (dir: string) => Promise<void>;

const defaultInstall: InstallRunner = async (dir) => {
    await promisify(execFile)("pnpm", ["install", "--lockfile-only", "--ignore-scripts"], {
        cwd: dir,
        timeout: RESOLVE_TIMEOUT_MS,
        env: { ...process.env, CI: "1", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" },
        maxBuffer: 16 * 1024 * 1024,
    });
};

// Every path the delta touches: the dirty tree, plus what the commits since `from` changed.
const changedPaths = async (dir: string, from: string | undefined, git: GitRunner): Promise<string[]> => {
    const status = await git(dir, ["status", "--porcelain", "--untracked-files=all"]);
    const dirty = status.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => line.slice(3).trim().split(" -> ").at(-1) ?? "");
    const committed =
        from === undefined
            ? []
            : await git(dir, ["diff", "--name-only", from, "HEAD"])
                  .then((result) => result.stdout.split("\n").filter(Boolean))
                  .catch(() => []);
    return [...dirty, ...committed];
};

// Whether the delta changed a manifest without changing the lockfile beside it.
export const lockfileBehind = async (dir: string, from: string | undefined, git: GitRunner = defaultGit): Promise<boolean> => {
    if (!existsSync(join(dir, LOCKFILE))) {
        return false;
    }
    const changed = await changedPaths(dir, from, git);
    return changed.some((path) => MANIFEST.test(path)) && !changed.includes(LOCKFILE);
};

export const reconcileLockfile = async (
    dir: string,
    from: string | undefined,
    git: GitRunner = defaultGit,
    install: InstallRunner = defaultInstall,
): Promise<LockfileReconciliation> => {
    if (!(await lockfileBehind(dir, from, git))) {
        return "current";
    }
    try {
        await install(dir);
        return "regenerated";
    } catch {
        return "failed";
    }
};
