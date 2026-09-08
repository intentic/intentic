import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { defaultGit, type GitRunner } from "@intentic/scaffold";

// A manifest edit and its lockfile must leave the worktree in the same patch: reconciled here, before the land commits
// the remainder, since a turn cannot install inside its own worktree. Runs only when the delta changed a manifest
// without the lockfile; best-effort, pnpm only.

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
