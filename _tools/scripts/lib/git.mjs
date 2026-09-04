/* ASKING GIT ABOUT THE CHECKOUT, once, for the scripts in this directory that all need the same three answers.
 *
 * Five of them had grown their own `const git = (...)` — the same `spawnSync`, differing only in whether a
 * failure came back as `undefined` or threw, and in whether somebody had remembered `maxBuffer`. That last one
 * is the reason this is a shared file rather than a style preference: node's default `maxBuffer` is 1 MiB, and
 * `git diff --name-only` over a release-sized range goes past it — at which point spawnSync reports a FAILURE
 * for a command that worked, and a caller reading "no changed paths" from it widens or narrows its scope
 * silently. The copies that had the bigger buffer had it because somebody hit that; the copies that did not,
 * did not.
 *
 * BY FILE, NOT BY PACKAGE NAME, like everything else these scripts import (see _tools/checks/lib/repo.mjs):
 * the pre-push hook runs on a clone that may never have installed, and a bare specifier resolves through
 * node_modules. */
import { spawnSync } from "node:child_process";

// 64 MiB: `git diff --name-only` over a release range and `git log` over two hundred commits both go past
// node's 1 MiB default, and spawnSync reports THAT as a failed command rather than as a truncated one.
const MAX_BUFFER = 64 * 1024 * 1024;

/* One git command in the checkout, as text — or `undefined` when git said no.
 *
 * A FAILURE IS AN ANSWER HERE, not an exception, because every caller has a sensible thing to do with "git
 * cannot tell me": a range with no upstream is measured differently, an unmerged index means re-measure, a
 * missing HEAD on a fresh clone means there is nothing to compare against. Throwing would make each of those a
 * try/catch, which is how one of them ends up swallowing a real error. */
export const git = (root, ...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: MAX_BUFFER });
    return result.status === 0 ? result.stdout : undefined;
};

/* Every path the WORKING TREE says changed: staged, unstaged and untracked alike, a rename by its new name.
 * `undefined` when git could not answer, which callers read as "measure everything" rather than "nothing
 * changed" — the two are opposite mistakes and only one of them is safe.
 *
 * `--untracked-files=all` rather than the default `normal`: normal collapses an untracked DIRECTORY to one
 * entry, so a new package's files would arrive as `_deploy/thing/` and no path-to-package walk would match. */
export const changedPaths = (root) => {
    const listing = git(root, "status", "--porcelain", "--untracked-files=all");
    return listing === undefined
        ? undefined
        : listing
              .split("\n")
              .filter(Boolean)
              .map((line) => line.slice(3).trim().split(" -> ").at(-1));
};

/* Whether this checkout is a linked worktree rather than the primary one — a checkout whose git dir is not its
 * common dir. Every agent turn runs in one, and it is what decides whether `pnpm build` can run at all: pnpm
 * hardlinks into `node_modules` after a build, a worktree's `node_modules` is a different filesystem, and the
 * run dies EXDEV. */
export const isLinkedWorktree = (root) => git(root, "rev-parse", "--git-dir")?.trim() !== git(root, "rev-parse", "--git-common-dir")?.trim();
