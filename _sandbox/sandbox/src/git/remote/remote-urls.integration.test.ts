import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitRunner } from "@intentic/scaffold";
import { expect, test } from "vitest";
import { remoteUrlsOf } from "./remote-urls.js";

// Tests the cache's `.git/config`-mtime validity rule with a counting fake runner; integration, not unit, since the
// rule needs a real mtime to watch. parseRemote's pure cases live in remote-urls.test.ts.

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

// A linked worktree's `.git` is a pointer file with no local config to watch; caching on it would go stale silently, so
// it's deliberately never cached.
test("a dir with no .git/config to watch is never cached", async () => {
    const dir = mkdtempSync(join(tmpdir(), "remote-urls-worktree-"));
    writeFileSync(join(dir, ".git"), "gitdir: /elsewhere/.git/worktrees/w\n");
    const { git, calls } = countingGit(ORIGIN);
    expect(await remoteUrlsOf(dir, git)).toEqual(["https://github.com/acme/web.git"]);
    expect(await remoteUrlsOf(dir, git)).toEqual(["https://github.com/acme/web.git"]);
    expect(calls()).toBe(2);
});

// The cached array is handed out by copy, so a caller's mutation can't reach it.
test("a caller mutating its answer does not corrupt the cached one", async () => {
    const dir = repoDir();
    const { git } = countingGit(ORIGIN);
    const first = await remoteUrlsOf(dir, git);
    first.push("https://example.com/injected.git");
    expect(await remoteUrlsOf(dir, git)).toEqual(["https://github.com/acme/web.git"]);
});
