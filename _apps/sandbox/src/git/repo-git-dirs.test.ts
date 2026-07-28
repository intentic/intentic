import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { repoGitDir } from "../history/history.js";
import { createLogger } from "../logger.js";
import { workspacePaths } from "../workspace/workspace.js";
import { ensureRepoGitDirs } from "./repo-git-dirs.js";

/* Against real git, because what is being asserted is what GIT makes of the result — a pointer git resolves,
 * a worktree git still owns — and no stub can answer that. */

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

// A workspace root with one nested repo carrying an ordinary in-tree .git, plus a history root beside it.
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
    // The point of the whole exercise: git resolves the repo through the pointer, and its git dir is no
    // longer anywhere under the workspace root.
    expect(await git(repo, "rev-parse", "--absolute-git-dir")).toBe(target);
    expect(await git(repo, "log", "--format=%s", "-1")).toBe("first");
    // Working tree intact — a bare repo would answer differently.
    expect(await git(repo, "rev-parse", "--is-bare-repository")).toBe("false");
});

test("an attached worktree survives the move and keeps its own branch", async () => {
    const { root, historyRoot, repo } = await workspace();
    const worktree = join(root, "..", "wt");
    await git(repo, "worktree", "add", "-q", "-b", "agent/x", worktree, "HEAD");

    await ensureRepoGitDirs(workspacePaths(root), historyRoot, logger);

    // Without the `worktree repair` this step makes, every existing conversation's checkout dies here.
    expect(await git(worktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe("agent/x");
    expect(await git(worktree, "status", "--porcelain")).toBe("");
    expect(await git(worktree, "rev-parse", "--absolute-git-dir")).toBe(join(repoGitDir(historyRoot, "app"), "worktrees", "wt"));
});

test("a repo already pointing out of tree is left exactly as it is", async () => {
    const { root, historyRoot, repo } = await workspace();
    await ensureRepoGitDirs(workspacePaths(root), historyRoot, logger);
    const pointer = await readFile(join(repo, ".git"), "utf8");

    // The steady state: every boot re-runs this, and the second run must be a no-op rather than a re-copy.
    await ensureRepoGitDirs(workspacePaths(root), historyRoot, logger);
    expect(await readFile(join(repo, ".git"), "utf8")).toBe(pointer);
    expect(await git(repo, "log", "--format=%s", "-1")).toBe("first");
});

test("an occupied target leaves the repo working rather than clobbering either git dir", async () => {
    const { root, historyRoot, repo } = await workspace();
    // Something else already parked under this id — the one case where relocation must decline.
    await mkdir(join(repoGitDir(historyRoot, "app"), "refs"), { recursive: true });

    await ensureRepoGitDirs(workspacePaths(root), historyRoot, logger);

    expect((await lstat(join(repo, ".git"))).isDirectory()).toBe(true);
    expect(await git(repo, "log", "--format=%s", "-1")).toBe("first");
});
