import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { REPO_ROLES } from "@intentic/scaffold";
import { IGNORED_DIRS } from "@intentic/workspace-ignore";

// VSCode-style repo discovery: a repo is any directory under /work owning a `.git` entry — dir OR pointer file
// (the daemon's own --separate-git-dir repos keep a pointer FILE in the worktree, as do git worktrees and
// submodules). Repo ids are root-relative POSIX paths ("intent", "clients/foo"); the id doubles as the repo's
// dir under the workspace root and as its wire {repo} name. The walk stops at the first .git boundary — a repo
// nested inside another repo (a submodule, an embedded clone) belongs to its parent, exactly like git itself
// sees it. The workspace root's own .git (the shadow "root" repo, git/root-repo.ts) is never a workspace repo.

// "root" is the /work workspace repo's {repo} name (its git dir lives at /history/gits/root) — a clone must
// never collide with it, and a top-level dir the agent names "root" is skipped by discovery for the same reason.
const RESERVED = new Set<string>([...REPO_ROLES, "root"]);
// A safe path segment: starts alphanumeric, no separators or `..`.
const SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
// Runaway guards for the recursive walk: repos deeper than this aren't discovered, and a pathological tree
// (a giant unignored dir farm) stops scanning rather than stalling the daemon.
const MAX_DEPTH = 4;
const MAX_DIRS = 10_000;

// A single-segment name for a repo the DAEMON creates at the top level (clone route, monorepo capability) —
// reserved names stay unclaimable so role scaffolding and the "root" scope can't collide with a clone.
export const isValidRepoName = (name: string): boolean => SEGMENT.test(name) && !RESERVED.has(name);

// A wire {repo} id naming an EXISTING repo anywhere under the root: 1–4 safe segments (each structurally
// excludes "..", empty parts, and absolute paths), so joining it under the root can never escape. Role names
// pass — they are ordinary repos now — but "root" stays the workspace repo's own name.
export const isValidRepoId = (id: string): boolean => {
    const segments = id.split("/");
    return segments.length <= MAX_DEPTH && segments.every((segment) => SEGMENT.test(segment)) && id !== "root";
};

export const hasGitEntry = async (dir: string): Promise<boolean> => {
    try {
        await access(join(dir, ".git"));
        return true;
    } catch {
        return false;
    }
};

// Every repo under `root`, as sorted root-relative ids. Hidden dirs (.git, .intentic, browser profiles) and
// junk dirs (node_modules, dist, …) are never descended into — same pruning as the tree walk and the watcher.
export const discoverRepos = async (root: string): Promise<string[]> => {
    const repos: string[] = [];
    let visited = 0;
    const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
        if (depth > MAX_DEPTH || visited >= MAX_DIRS) {
            return;
        }
        visited += 1;
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            if (!entry.isDirectory() || entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) {
                continue;
            }
            const id = rel === "" ? entry.name : `${rel}/${entry.name}`;
            if (id === "root" || !SEGMENT.test(entry.name)) {
                continue;
            }
            const child = join(dir, entry.name);
            if (await hasGitEntry(child)) {
                repos.push(id);
                continue;
            }
            await walk(child, id, depth + 1);
        }
    };
    await walk(root, "", 1);
    return repos.toSorted();
};
