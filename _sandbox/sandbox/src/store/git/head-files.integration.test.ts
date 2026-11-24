import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultGit } from "@intentic/base/git";
import { branchSha } from "../../git/agent-refs.js";
import { headShaFromFiles, refShaFromFiles } from "./head-files.js";

// HEAD read off the files must be git's own answer wherever it gives one: a loose ref, a packed one, a detached HEAD,
// a linked worktree's, and nothing at all where git would have to say (unborn, no checkout).

const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" }).trim();

const root = mkdtempSync(join(tmpdir(), "head-files-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const repo = join(root, "repo");
git(root, "init", "-q", repo);

test(`an unborn branch is git's to say`, async () => {
    expect(await headShaFromFiles(repo)).toBeUndefined();
});

test(`a loose ref, then the same ref packed, then a detached HEAD each read as git reads them`, async () => {
    git(repo, "commit", "-q", "--allow-empty", "-m", "one");
    expect(await headShaFromFiles(repo)).toBe(git(repo, "rev-parse", "HEAD"));
    git(repo, "pack-refs", "--all");
    git(repo, "commit", "-q", "--allow-empty", "-m", "two");
    // The new commit's loose ref stands over the packed line for the same name.
    expect(await headShaFromFiles(repo)).toBe(git(repo, "rev-parse", "HEAD"));
    git(repo, "pack-refs", "--all");
    expect(await headShaFromFiles(repo)).toBe(git(repo, "rev-parse", "HEAD"));
    git(repo, "checkout", "-q", "--detach", "HEAD~1");
    expect(await headShaFromFiles(repo)).toBe(git(repo, "rev-parse", "HEAD"));
    git(repo, "checkout", "-q", "main");
});

test(`a linked worktree reads its own HEAD and the common dir's refs`, async () => {
    const linked = join(root, "linked");
    git(repo, "worktree", "add", "-q", "-b", "side", linked, "HEAD~1");
    expect(await headShaFromFiles(linked)).toBe(git(linked, "rev-parse", "HEAD"));
    expect(await headShaFromFiles(linked)).not.toBe(await headShaFromFiles(repo));
    git(linked, "commit", "-q", "--allow-empty", "-m", "side");
    expect(await headShaFromFiles(linked)).toBe(git(linked, "rev-parse", "HEAD"));
});

test(`a directory that is no checkout answers nothing`, async () => {
    expect(await headShaFromFiles(join(root, "nowhere"))).toBeUndefined();
});

test(`a branch reads off its loose file or its packed line, and one the files do not hold is git's to look for`, async () => {
    git(repo, "branch", "agent/one");
    expect(await refShaFromFiles(repo, "refs/heads/agent/one")).toBe(git(repo, "rev-parse", "agent/one"));
    git(repo, "update-ref", "refs/agent/two", "HEAD~1");
    git(repo, "pack-refs", "--all");
    expect(await refShaFromFiles(repo, "refs/agent/two")).toBe(git(repo, "rev-parse", "refs/agent/two"));
    expect(await refShaFromFiles(join(root, "linked"), "refs/agent/two")).toBe(git(repo, "rev-parse", "refs/agent/two"));
    expect(await refShaFromFiles(repo, "refs/heads/agent/none")).toBeUndefined();
});

test(`branchSha answers as git's listing does, the parked spelling first`, async () => {
    git(repo, "update-ref", "refs/heads/agent/three", "HEAD");
    expect(await branchSha(repo, "agent/three", defaultGit)).toBe(git(repo, "rev-parse", "HEAD"));
    git(repo, "update-ref", "refs/agent/three", "HEAD~1");
    expect(await branchSha(repo, "agent/three", defaultGit)).toBe(git(repo, "rev-parse", "HEAD~1"));
    expect(await branchSha(repo, "agent/gone", defaultGit)).toBeUndefined();
});
