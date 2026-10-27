import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// What `lsp diag --changed` checks: the files that differ between the working tree and where the branch left the main
// line, plus the untracked ones, as absolute paths. The working tree, not HEAD, so what is not committed yet counts.

// The lines a branch is read as leaving, in order; the first one that exists answers.
const MAIN_LINES = ["main", "origin/main", "origin/HEAD", "master", "origin/master"];

export interface Changed {
    readonly root: string;
    // What the change is measured against: a merge base, or HEAD where no main line exists (then only what is not committed).
    readonly base: string;
    readonly baseName: string;
    readonly files: readonly string[];
}

const git = (cwd: string, args: readonly string[]): string | undefined => {
    const run = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return run.status === 0 ? run.stdout : undefined;
};

const linesOf = (text: string | undefined): string[] => (text ?? "").split("\n").filter((line) => line !== "");

/** The changed and untracked files of the repository `cwd` is in, or why they cannot be read. */
export const changedFiles = (cwd: string): Changed | { readonly failure: string } => {
    const root = git(cwd, ["rev-parse", "--show-toplevel"])?.trim();
    if (root === undefined || root === "") {
        return { failure: `${cwd} is not inside a git repository` };
    }
    let base: { sha: string; name: string } | undefined;
    for (const line of MAIN_LINES) {
        const sha = git(root, ["merge-base", "HEAD", line])?.trim();
        if (sha !== undefined && sha !== "") {
            base = { sha, name: `the branch point with ${line}` };
            break;
        }
    }
    base ??= { sha: "HEAD", name: "HEAD (no main line to measure from)" };
    const diff = git(root, ["diff", "--name-only", "--no-renames", "--diff-filter=d", base.sha]);
    if (diff === undefined) {
        return { failure: `git diff against ${base.sha} failed` };
    }
    const untracked = git(root, ["ls-files", "--others", "--exclude-standard"]);
    const files = [...new Set([...linesOf(diff), ...linesOf(untracked)])].map((path) => resolve(root, path)).filter((path) => existsSync(path));
    return { root, base: base.sha, baseName: base.name, files: files.toSorted() };
};
