import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitRunner } from "@intentic/scaffold";
import { expect, test } from "vitest";
import { remoteUrlsOf } from "./remote-urls.js";

/* THE CACHE, which is why this read stopped being ~20% of every git subprocess the daemon runs. Its whole
 * validity rule is `.git/config`'s mtime, so these are about that file rather than about git: a counting runner
 * stands in for the spawn, and what is asserted is how many times it was reached.
 *
 * Integration rather than unit despite the fake runner: they mkdtemp real trees, which is what the mtime rule
 * needs something to watch, and that is the line the unit budget draws (_tools/checks/test-programs.mjs). `parseRemote`'s own cases
 * are pure and stay next door in remote-urls.test.ts. */

// A repo-shaped dir: just enough for the mtime rule to have something to watch. Each test gets its own, since
// the cache is keyed by dir.
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
    // Stamped explicitly rather than rewritten: two writes inside one filesystem tick can share an mtime, and
    // what is under test is the rule, not the clock's resolution.
    const moved = new Date(Date.now() + 10_000);
    utimesSync(join(dir, ".git", "config"), moved, moved);
    const second = countingGit("origin\tgit@gitlab.example.com:group/app.git (fetch)\n");
    expect(await remoteUrlsOf(dir, second.git)).toEqual(["git@gitlab.example.com:group/app.git"]);
    expect(second.calls()).toBe(1);
});

/* A linked worktree's `.git` is a FILE naming a gitdir elsewhere, so there is no local config to watch and a
 * cache keyed on the pointer would go stale silently. Such a dir is deliberately not cached at all. */
test("a dir with no .git/config to watch is never cached", async () => {
    const dir = mkdtempSync(join(tmpdir(), "remote-urls-worktree-"));
    writeFileSync(join(dir, ".git"), "gitdir: /elsewhere/.git/worktrees/w\n");
    const { git, calls } = countingGit(ORIGIN);
    expect(await remoteUrlsOf(dir, git)).toEqual(["https://github.com/acme/web.git"]);
    expect(await remoteUrlsOf(dir, git)).toEqual(["https://github.com/acme/web.git"]);
    expect(calls()).toBe(2);
});

// The cached array is handed out by copy, so a caller that sorts or splices its answer cannot edit what the
// next reader gets.
test("a caller mutating its answer does not corrupt the cached one", async () => {
    const dir = repoDir();
    const { git } = countingGit(ORIGIN);
    const first = await remoteUrlsOf(dir, git);
    first.push("https://example.com/injected.git");
    expect(await remoteUrlsOf(dir, git)).toEqual(["https://github.com/acme/web.git"]);
});
