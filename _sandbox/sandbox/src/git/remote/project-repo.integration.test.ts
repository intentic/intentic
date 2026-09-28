import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { pathExists } from "@intentic/base/fs";
import { createLogger } from "../../logger.js";
import { repoGitDir, rootExcludes } from "../../workspace/layout/git-layout.js";
import { discoverRepos } from "../../workspace/layout/repo-discovery.js";
import { workspacePaths } from "../../workspace/workspace.js";
import { ensureProjectRepo } from "./project-repo.js";
import { ensureRepoGitDirs } from "./repo-git-dirs.js";
import { commitRootBaseline, ensureRootRepo } from "./root-repo.js";

// Runs against real git in the container layout (git dirs relocated onto a history root beside the workspace): what git
// itself resolves the folder to is the point, which no stub can stand in for.

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
// Commits reachable from any ref: "0" is a repo nothing was ever committed to.
const commitCount = (cwd: string): Promise<string> => git(cwd, "rev-list", "--all", "--count");
const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });

const NAME = "my-app";

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

// A workspace root and a history root beside it, and where the project folder syncs to; the folder itself is left to
// each test, since whether file sync has delivered it yet is what several of them are about.
const layout = async (): Promise<{ root: string; historyRoot: string; project: string }> => {
    const base = await mkdtemp(join(tmpdir(), "project-repo-"));
    tempDirs.push(base);
    const root = join(base, "work");
    await mkdir(root, { recursive: true });
    return { root, historyRoot: join(base, "history"), project: join(root, NAME) };
};

test("an empty folder becomes a repo with its git dir on the history root and nothing committed", async () => {
    const { root, historyRoot, project } = await layout();
    await mkdir(project);

    expect(await ensureProjectRepo(workspacePaths(root), historyRoot, NAME)).toBe("created");

    const target = repoGitDir(historyRoot, NAME);
    expect(await readFile(join(project, ".git"), "utf8")).toBe(`gitdir: ${target}\n`);
    expect(await git(project, "rev-parse", "--absolute-git-dir")).toBe(target);
    expect(await git(project, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
    expect(await commitCount(project)).toBe("0");
    expect(await discoverRepos(root)).toEqual([NAME]);
});

// File sync may not have made the folder yet on a sandbox's first boot; the repo stands before the first file lands.
test("a folder file sync has not delivered yet is made, already a repo", async () => {
    const { root, historyRoot, project } = await layout();

    expect(await ensureProjectRepo(workspacePaths(root), historyRoot, NAME)).toBe("created");

    expect(await git(project, "rev-parse", "--absolute-git-dir")).toBe(repoGitDir(historyRoot, NAME));
    expect(await discoverRepos(root)).toEqual([NAME]);
});

test("a folder that already holds the owner's files keeps every one of them, untracked and uncommitted", async () => {
    const { root, historyRoot, project } = await layout();
    await mkdir(join(project, "src"), { recursive: true });
    await writeFile(join(project, "README.md"), "# my app\n");
    await writeFile(join(project, "src", "main.ts"), "export {};\n");

    expect(await ensureProjectRepo(workspacePaths(root), historyRoot, NAME)).toBe("created");

    expect(await readFile(join(project, "README.md"), "utf8")).toBe("# my app\n");
    expect(await git(project, "ls-files")).toBe("");
    expect(await git(project, "status", "--porcelain", "--untracked-files=all")).toBe("?? README.md\n?? src/main.ts");
    expect(await commitCount(project)).toBe("0");
});

// The steady state every later boot repeats.
test("a second boot finds the repo standing and changes nothing", async () => {
    const { root, historyRoot, project } = await layout();
    await ensureProjectRepo(workspacePaths(root), historyRoot, NAME);
    const pointer = await readFile(join(project, ".git"), "utf8");

    expect(await ensureProjectRepo(workspacePaths(root), historyRoot, NAME)).toBe("already a repo");

    expect(await readFile(join(project, ".git"), "utf8")).toBe(pointer);
    expect(await git(project, "rev-parse", "--absolute-git-dir")).toBe(repoGitDir(historyRoot, NAME));
    expect(await commitCount(project)).toBe("0");
});

// An agent's `rm .git` loses the pointer, never the git dir on the history root; a fresh init would orphan what it holds.
test("a git dir whose pointer went missing gets its pointer back, its history whole", async () => {
    const { root, historyRoot, project } = await layout();
    await mkdir(project);
    await ensureProjectRepo(workspacePaths(root), historyRoot, NAME);
    await writeFile(join(project, "notes.md"), "kept\n");
    await git(project, "add", "notes.md");
    await git(project, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "first snapshot");
    const committed = await git(project, "rev-parse", "HEAD");
    await rm(join(project, ".git"));

    expect(await ensureProjectRepo(workspacePaths(root), historyRoot, NAME)).toBe("pointer restored");

    expect(await readFile(join(project, ".git"), "utf8")).toBe(`gitdir: ${repoGitDir(historyRoot, NAME)}\n`);
    expect(await git(project, "rev-parse", "HEAD")).toBe(committed);
    expect(await git(project, "log", "--format=%s")).toBe("first snapshot");
});

// The relocation step moves it onto the history root right after; this step must not race it for the same git dir.
test("an in-tree git dir is left for the relocation step, which then gives the folder the same layout", async () => {
    const { root, historyRoot, project } = await layout();
    await mkdir(project);
    await git(project, "init", "-q", "-b", "main");

    expect(await ensureProjectRepo(workspacePaths(root), historyRoot, NAME)).toBe("left to relocation");
    expect((await lstat(join(project, ".git"))).isDirectory()).toBe(true);
    expect(await pathExists(repoGitDir(historyRoot, NAME))).toBe(false);

    await ensureRepoGitDirs(workspacePaths(root), historyRoot, logger);
    expect(await readFile(join(project, ".git"), "utf8")).toBe(`gitdir: ${repoGitDir(historyRoot, NAME)}\n`);
});

// The boot's order: the root repo first, whose excludes cannot yet name a folder that is not a repo, then this, then
// the baseline. The project's files must stay the project's, never the workspace repo's first commit.
test("the workspace repo's baseline leaves the project's files out, though they arrived before the folder was a repo", async () => {
    const { root, historyRoot, project } = await layout();
    await mkdir(project);
    await writeFile(join(project, "README.md"), "# my app\n");
    await writeFile(join(root, "notes.md"), "the workspace's own\n");

    expect(await ensureRootRepo(workspacePaths(root), historyRoot)).toBe(true);
    await ensureProjectRepo(workspacePaths(root), historyRoot, NAME);
    await commitRootBaseline(workspacePaths(root));

    expect(await readFile(join(repoGitDir(historyRoot, "root"), "info", "exclude"), "utf8")).toBe(`${rootExcludes([NAME]).join("\n")}\n`);
    expect(await git(root, "ls-files")).toBe("notes.md");
    expect(await git(root, "status", "--porcelain")).toBe("");
});

// Init writes `core.fileMode=true` on Linux; the git-dir convergence that runs next writes `false`, as for any repo.
test("the git-dir convergence that follows reads the folder's mode bits as the daemon does", async () => {
    const { root, historyRoot, project } = await layout();
    await ensureProjectRepo(workspacePaths(root), historyRoot, NAME);

    await ensureRepoGitDirs(workspacePaths(root), historyRoot, logger);

    expect(await git(project, "config", "--local", "--get", "core.fileMode")).toBe("false");
});
