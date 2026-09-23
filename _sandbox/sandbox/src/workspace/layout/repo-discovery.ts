import { access } from "node:fs/promises";
import { join } from "node:path";
import { REPO_ROLES } from "@intentic/scaffold";
import { isPublicPath, isReferencePath, PUBLIC_DIR, REFERENCE_DIR } from "@intentic/workspace-ignore";
import { walkDirs } from "./dir-walk.js";

// A repo is any dir under /work with a `.git` entry (dir or pointer file, for worktrees/submodules); ids are
// root-relative POSIX paths, doubling as the {repo} wire name.
// The walk stops at the first `.git` boundary; a nested repo belongs to its parent, as git itself sees it.
// The workspace root's own `.git` (the shadow root repo) is never a workspace repo.

// Reserved {repo} names: role names, "root" (the workspace's own repo), the reference shelf, and the outbox.
const RESERVED = new Set<string>([...REPO_ROLES, "root", REFERENCE_DIR, PUBLIC_DIR]);
// A safe path segment: starts alphanumeric, no separators or `..`.
const SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
// Guards a pathological tree: repos past this depth aren't discovered; a giant dir farm stops scanning.
const MAX_DEPTH = 4;
const MAX_DIRS = 10_000;

// A top-level name for a daemon-created repo (clone, monorepo capability); reserved names stay unclaimable.
export const isValidRepoName = (name: string): boolean => SEGMENT.test(name) && !RESERVED.has(name);

// A wire {repo} id naming an existing repo under root: 1-4 safe segments, so joining it under root can never escape.
// "root" and the reference shelf are excluded; discovery never returns those, so no id may name one either.
export const isValidRepoId = (id: string): boolean => {
    const segments = id.split("/");
    return (
        segments.length <= MAX_DEPTH &&
        segments.every((segment) => SEGMENT.test(segment)) &&
        id !== "root" &&
        !isReferencePath(id) &&
        !isPublicPath(id)
    );
};

export const hasGitEntry = async (dir: string): Promise<boolean> => {
    try {
        await access(join(dir, ".git"));
        return true;
    } catch {
        return false;
    }
};

// Every repo under root, as sorted root-relative ids.
export const discoverRepos = async (root: string): Promise<string[]> => {
    const repos: string[] = [];
    await walkDirs(root, { maxDepth: MAX_DEPTH - 1, maxDirs: MAX_DIRS }, async (_dir, _entries, subdirs) => {
        const named = subdirs.filter((subdir) => SEGMENT.test(subdir.name) && !["root", REFERENCE_DIR, PUBLIC_DIR].includes(subdir.rel));
        const isRepo = await Promise.all(named.map((subdir) => hasGitEntry(subdir.path)));
        repos.push(...named.filter((_, index) => isRepo[index]).map((subdir) => subdir.rel));
        return named.filter((_, index) => !isRepo[index]);
    });
    return repos.toSorted();
};
