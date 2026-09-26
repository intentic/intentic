// Shared git helper for the scripts in this directory, so `maxBuffer` (git output can exceed node's 1 MiB default) is
// fixed once rather than per copy. Imported by file, not package name: the pre-push hook runs on a clone that may not
// have installed.
import { spawnSync } from "node:child_process";

// Past node's 1 MiB default, a large diff or log otherwise reports as a failed spawn, not a truncated one.
const MAX_BUFFER = 64 * 1024 * 1024;

// Runs one git command: `{ stdout }`, or `{ error }` naming the command and what git said, for a caller that must say why.
export const gitAnswer = (root, ...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: MAX_BUFFER });
    if (result.status === 0) {
        return { stdout: result.stdout };
    }
    const said = (result.error?.message ?? result.stderr ?? "").trim();
    return { error: `git ${args.join(" ")}: ${said === "" ? `exit ${result.status ?? "signal"}` : said}` };
};

// Runs one git command; returns `undefined` on failure rather than throwing, since callers decide what "git cannot tell
// me" means for them.
export const git = (root, ...args) => gitAnswer(root, ...args).stdout;

// Every path the tree differs on from `base`, committed or not, untracked included: `{ paths }`, or `{ error }` with
// git's own words when it cannot answer.
export const changesSince = (root, base) => {
    const tracked = gitAnswer(root, "diff", "--name-only", "--no-renames", base);
    const untracked = gitAnswer(root, "ls-files", "--others", "--exclude-standard");
    const error = tracked.error ?? untracked.error;
    return error === undefined ? { paths: [...new Set([...tracked.stdout.split("\n"), ...untracked.stdout.split("\n")].filter(Boolean))] } : { error };
};

// changesSince's paths; `undefined` when git cannot answer.
export const changedSince = (root, base) => changesSince(root, base).paths;

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
