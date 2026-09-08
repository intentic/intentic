import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { repoGitDir } from "../../history/history.js";
import { createLogger } from "../../logger.js";
import { workspacePaths } from "../../workspace/workspace.js";
import { ensureRepoGitDirs } from "./repo-git-dirs.js";

// Runs against real git: asserts what git itself resolves a pointer and worktree to, which no stub can stand in for.

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

// Workspace root with one nested repo (ordinary in-tree .git) and a history root beside it.
const workspace = async (): Promise<{ root: string; historyRoot: string; repo: string }> => {
    const base = await mkdtemp(join(tmpdir(), "gitdirs-"));
    tempDirs.push(base);
    const root = join(base, "work");
    const historyRoot = join(base, "history");
    const repo = join(root, "app");
    await mkdir(repo, { recursive: true });
    await mkdir(historyRoot, { recursive: true });
    await git(repo, "init", "-q", "-b", "main");
    await git(repo, "config", "user.email", "t@example.com");
    await git(repo, "config", "user.name", "t");
    await writeFile(join(repo, "file.txt"), "one\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "first");
    return { root, historyRoot, repo };
};

test("an in-tree git dir moves onto the history volume and leaves a working pointer", async () => {
    const { root, historyRoot, repo } = await workspace();
    await ensureRepoGitDirs(workspacePaths(root), historyRoot, logger);

    const target = repoGitDir(historyRoot, "app");
    expect((await lstat(target)).isDirectory()).toBe(true);
    expect((await lstat(join(repo, ".git"))).isFile()).toBe(true);
    expect(await readFile(join(repo, ".git"), "utf8")).toBe(`gitdir: ${target}\n`);
    expect(await git(repo, "rev-parse", "--absolute-git-dir")).toBe(target);
    expect(await git(repo, "log", "--format=%s", "-1")).toBe("first");
    expect(await git(repo, "rev-parse", "--is-bare-repository")).toBe("false");
});

test("an attached worktree survives the move and keeps its own branch", async () => {
    const { root, historyRoot, repo } = await workspace();
    const worktree = join(root, "..", "wt");
    await git(repo, "worktree", "add", "-q", "-b", "agent/x", worktree, "HEAD");

    await ensureRepoGitDirs(workspacePaths(root), historyRoot, logger);

    expect(await git(worktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe("agent/x");
    expect(await git(worktree, "status", "--porcelain")).toBe("");
    expect(await git(worktree, "rev-parse", "--absolute-git-dir")).toBe(join(repoGitDir(historyRoot, "app"), "worktrees", "wt"));
});

test("a repo already pointing out of tree is left exactly as it is", async () => {
    const { root, historyRoot, repo } = await workspace();
    await ensureRepoGitDirs(workspacePaths(root), historyRoot, logger);
    const pointer = await readFile(join(repo, ".git"), "utf8");

    // Second call must be a no-op: this is the steady state every boot repeats.
    await ensureRepoGitDirs(workspacePaths(root), historyRoot, logger);
    expect(await readFile(join(repo, ".git"), "utf8")).toBe(pointer);
    expect(await git(repo, "log", "--format=%s", "-1")).toBe("first");
});

test("the relocated repo pins no working tree, so its path means the caller's tree and not one written down", async () => {
    const { root, historyRoot, repo } = await workspace();
    await ensureRepoGitDirs(workspacePaths(root), historyRoot, logger);

    await expect(git(repo, "config", "--get", "core.worktree")).rejects.toThrow();
    expect(await git(repo, "rev-parse", "--show-toplevel")).toBe(await realpath(repo));
});

test("a repo converged by an earlier boot still loses a worktree pin left behind by that boot", async () => {
    const { root, historyRoot, repo } = await workspace();
    await ensureRepoGitDirs(workspacePaths(root), historyRoot, logger);
    // Simulates a stale worktree pin left by an earlier boot's convergence.
    await git(repo, "config", "core.worktree", repo);

    await ensureRepoGitDirs(workspacePaths(root), historyRoot, logger);

    await expect(git(repo, "config", "--get", "core.worktree")).rejects.toThrow();
});

test("a git dir that calls itself bare gets its main checkout back", async () => {
    const { root, historyRoot, repo } = await workspace();
    await ensureRepoGitDirs(workspacePaths(root), historyRoot, logger);
    // Simulates a repo cloned `--bare` and later given a checkout.
    await git(repo, "config", "core.bare", "true");
    await expect(git(repo, "status", "--porcelain")).rejects.toThrow(/must be run in a work tree/);

    await ensureRepoGitDirs(workspacePaths(root), historyRoot, logger);

    expect(await git(repo, "config", "--get", "core.bare")).toBe("false");
    expect(await git(repo, "status", "--porcelain")).toBe("");
});

test("an occupied target leaves the repo working rather than clobbering either git dir", async () => {
    const { root, historyRoot, repo } = await workspace();
    await mkdir(join(repoGitDir(historyRoot, "app"), "refs"), { recursive: true });

    await ensureRepoGitDirs(workspacePaths(root), historyRoot, logger);

    expect((await lstat(join(repo, ".git"))).isDirectory()).toBe(true);
    expect(await git(repo, "log", "--format=%s", "-1")).toBe("first");
});
