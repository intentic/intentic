// Shared git helper for the scripts in this directory, so `maxBuffer` (git output can exceed node's 1 MiB default) is
// fixed once rather than per copy. Imported by file, not package name: the pre-push hook runs on a clone that may not
// have installed.
import { spawnSync } from "node:child_process";

// Past node's 1 MiB default, a large diff or log otherwise reports as a failed spawn, not a truncated one.
const MAX_BUFFER = 64 * 1024 * 1024;

// Runs one git command; returns `undefined` on failure rather than throwing, since callers decide what "git cannot tell
// me" means for them.
export const git = (root, ...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: MAX_BUFFER });
    return result.status === 0 ? result.stdout : undefined;
};

// Every path the tree differs on from `base`, committed or not, untracked included; `undefined` when git cannot answer.
export const changedSince = (root, base) => {
    const tracked = git(root, "diff", "--name-only", "--no-renames", base);
    const untracked = git(root, "ls-files", "--others", "--exclude-standard");
    return tracked === undefined || untracked === undefined ? undefined : [...new Set([...tracked.split("\n"), ...untracked.split("\n")].filter(Boolean))];
};

// Every changed path: staged, unstaged, untracked, a rename by its new name. `undefined` means git couldn't answer
// ("measure everything", not "nothing changed"). `--untracked-files=all`, or an untracked directory collapses to one
// entry.
export const changedPaths = (root) => {
    const listing = git(root, "status", "--porcelain", "--untracked-files=all");
    return listing === undefined
        ? undefined
        : listing
              .split("\n")
              .filter(Boolean)
              .map((line) => line.slice(3).trim().split(" -> ").at(-1));
};
