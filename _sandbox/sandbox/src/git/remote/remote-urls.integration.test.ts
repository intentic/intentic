import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitRunner } from "@intentic/scaffold";
import { test, expect } from "bun:test";
import { remoteUrlsOf } from "./remote-urls.js";

// Tests the cache's config-mtime validity rule with a counting fake runner; integration, not unit, since the rule needs
// a real mtime to watch. parseRemote's pure cases live in remote-urls.test.ts.

// Repo-shaped dir with just enough for the mtime rule to watch; each test gets its own (cache keyed by dir).
const repoDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "remote-urls-"));
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".git", "config"), '[remote "origin"]\n');
    return dir;
};

const countingGit = (stdout: string): { git: GitRunner; calls: () => number } => {
    let calls = 0;
    return {
        git: async () => {
            calls += 1;
            return { stdout, stderr: "" };
        },
        calls: () => calls,
    };
};

const ORIGIN = "origin\thttps://github.com/acme/web.git (fetch)\norigin\thttps://github.com/acme/web.git (push)\n";

test("a repeat read is served without a spawn while .git/config is untouched", async () => {
    const dir = repoDir();
    const { git, calls } = countingGit(ORIGIN);
    expect(await remoteUrlsOf(dir, git)).toEqual(["https://github.com/acme/web.git"]);
    expect(await remoteUrlsOf(dir, git)).toEqual(["https://github.com/acme/web.git"]);
    expect(await remoteUrlsOf(dir, git)).toEqual(["https://github.com/acme/web.git"]);
    expect(calls()).toBe(1);
});

test("a write to .git/config re-reads, so an added or moved remote is never served stale", async () => {
    const dir = repoDir();
    const first = countingGit(ORIGIN);
    expect(await remoteUrlsOf(dir, first.git)).toEqual(["https://github.com/acme/web.git"]);
    // Stamped explicitly, not rewritten: two writes in one filesystem tick can share an mtime.
    const moved = new Date(Date.now() + 10_000);
    utimesSync(join(dir, ".git", "config"), moved, moved);
    const second = countingGit("origin\tgit@gitlab.example.com:group/app.git (fetch)\n");
    expect(await remoteUrlsOf(dir, second.git)).toEqual(["git@gitlab.example.com:group/app.git"]);
    expect(second.calls()).toBe(1);
});

// A pointer whose admin dir is gone has no config to watch; caching on it would go stale silently.
test("a torn .git pointer is never cached", async () => {
    const dir = mkdtempSync(join(tmpdir(), "remote-urls-torn-"));
    writeFileSync(join(dir, ".git"), "gitdir: /elsewhere/.git/worktrees/w\n");
    const { git, calls } = countingGit(ORIGIN);
    expect(await remoteUrlsOf(dir, git)).toEqual(["https://github.com/acme/web.git"]);
    expect(await remoteUrlsOf(dir, git)).toEqual(["https://github.com/acme/web.git"]);
    expect(calls()).toBe(2);
});

// A linked worktree's `.git` is a pointer file; its remotes live in the common dir's config, shared with the main
// checkout, which `commondir` names relative to the worktree's admin dir.
const linkedWorktree = (): { worktree: string; commonConfig: string } => {
    const root = mkdtempSync(join(tmpdir(), "remote-urls-linked-"));
    const common = join(root, "repo.git");
    const admin = join(common, "worktrees", "w");
    mkdirSync(admin, { recursive: true });
    writeFileSync(join(common, "config"), '[remote "origin"]\n');
    writeFileSync(join(admin, "commondir"), "../..\n");
    const worktree = join(root, "checkout");
    mkdirSync(worktree);
    writeFileSync(join(worktree, ".git"), `gitdir: ${admin}\n`);
    return { worktree, commonConfig: join(common, "config") };
};

test("a linked worktree is served from cache while its common config is untouched", async () => {
    const { worktree } = linkedWorktree();
    const { git, calls } = countingGit(ORIGIN);
    expect(await remoteUrlsOf(worktree, git)).toEqual(["https://github.com/acme/web.git"]);
    expect(await remoteUrlsOf(worktree, git)).toEqual(["https://github.com/acme/web.git"]);
    expect(calls()).toBe(1);
});

test("a write to a linked worktree's common config re-reads", async () => {
    const { worktree, commonConfig } = linkedWorktree();
    const first = countingGit(ORIGIN);
    expect(await remoteUrlsOf(worktree, first.git)).toEqual(["https://github.com/acme/web.git"]);
    const moved = new Date(Date.now() + 10_000);
    utimesSync(commonConfig, moved, moved);
    const second = countingGit("origin\tgit@gitlab.example.com:group/app.git (fetch)\n");
    expect(await remoteUrlsOf(worktree, second.git)).toEqual(["git@gitlab.example.com:group/app.git"]);
    expect(second.calls()).toBe(1);
});

// A submodule's pointer names its own admin dir (no `commondir`), which holds its config.
test("a relative pointer with no commondir is cached on its admin dir's own config", async () => {
    const root = mkdtempSync(join(tmpdir(), "remote-urls-submodule-"));
    mkdirSync(join(root, ".git", "modules", "lib"), { recursive: true });
    writeFileSync(join(root, ".git", "modules", "lib", "config"), '[remote "origin"]\n');
    mkdirSync(join(root, "lib"));
    writeFileSync(join(root, "lib", ".git"), "gitdir: ../.git/modules/lib\n");
    const { git, calls } = countingGit(ORIGIN);
    expect(await remoteUrlsOf(join(root, "lib"), git)).toEqual(["https://github.com/acme/web.git"]);
    expect(await remoteUrlsOf(join(root, "lib"), git)).toEqual(["https://github.com/acme/web.git"]);
    expect(calls()).toBe(1);
});

// The cached array is handed out by copy, so a caller's mutation can't reach it.
test("a caller mutating its answer does not corrupt the cached one", async () => {
    const dir = repoDir();
    const { git } = countingGit(ORIGIN);
    const first = await remoteUrlsOf(dir, git);
    first.push("https://example.com/injected.git");
    expect(await remoteUrlsOf(dir, git)).toEqual(["https://github.com/acme/web.git"]);
});
