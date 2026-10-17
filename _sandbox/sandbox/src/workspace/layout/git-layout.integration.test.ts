import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { projectExcludes, syncProjectExcludes } from "./git-layout.js";

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

// Creates a workspace root with a project repo that has an in-place `.git` directory.
const tempWorkspace = async (): Promise<{ root: string; repo: string }> => {
    const root = await mkdtemp(join(tmpdir(), "intentic-layout-"));
    tempDirs.push(root);
    const repo = join(root, "app");
    await mkdir(repo, { recursive: true });
    await sh(repo, "init", "-q", "--initial-branch=main");
    await writeFile(join(repo, "index.ts"), "export {};\n");
    await sh(repo, "add", "-A");
    await sh(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
    return { root, repo };
};

test("projectExcludes returns an any-depth directory pattern for every IGNORED_DIRS entry except .git", () => {
    const excludes = projectExcludes();
    expect(excludes.length).toBeGreaterThan(0);
    // Every entry matches the directory at any depth, like `node_modules/`.
    for (const pattern of excludes) {
        expect(pattern).toMatch(/^[^/]+\/$/);
    }
    // .git must not appear (git already ignores its own data directory).
    expect(excludes).not.toContain(".git/");
    // The heavy hitters must be present.
    expect(excludes).toContain("node_modules/");
    expect(excludes).toContain(".venv/");
    expect(excludes).toContain("venv/");
});

test("syncProjectExcludes writes heavy-dir patterns into a project repo's info/exclude", async () => {
    const { root, repo } = await tempWorkspace();
    await syncProjectExcludes(root, ["app"]);

    const exclude = await readFile(join(repo, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain("node_modules/");
    expect(exclude).toContain(".venv/");
    // A second call is idempotent — no duplicates.
    await syncProjectExcludes(root, ["app"]);
    const after = await readFile(join(repo, ".git", "info", "exclude"), "utf8");
    const count = (after.match(/^node_modules\/$/gm) ?? []).length;
    expect(count).toBe(1);
});

test("a node_modules dir in a project repo is hidden from git status after syncProjectExcludes", async () => {
    const { root, repo } = await tempWorkspace();
    // Create a fake node_modules with files.
    await mkdir(join(repo, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(repo, "node_modules", "pkg", "index.js"), "module.exports = {};\n");

    // Before the exclude, node_modules shows up as untracked.
    const before = await sh(repo, "status", "--porcelain", "-uall");
    expect(before).toContain("node_modules/");

    // Apply the excludes.
    await syncProjectExcludes(root, ["app"]);

    // After the exclude, node_modules is hidden.
    const after = await sh(repo, "status", "--porcelain", "-uall");
    expect(after).not.toContain("node_modules/");
});

test("a dependency dir nested anywhere in a project repo is hidden too, where the user's 53k files were", async () => {
    const { root, repo } = await tempWorkspace();
    await mkdir(join(repo, ".local", "lib", "node_modules", "pkg"), { recursive: true });
    await writeFile(join(repo, ".local", "lib", "node_modules", "pkg", "index.js"), "module.exports = {};\n");
    await mkdir(join(repo, "backend", ".venv", "lib"), { recursive: true });
    await writeFile(join(repo, "backend", ".venv", "lib", "site.py"), "\n");
    await writeFile(join(repo, "backend", "main.py"), "print('hi')\n");
    await syncProjectExcludes(root, ["app"]);
    expect(await sh(repo, "status", "--porcelain", "-uall")).toBe("?? backend/main.py");
});

test("syncProjectExcludes follows a relative .git pointer and a linked worktree to the git dir git reads", async () => {
    const { root, repo } = await tempWorkspace();
    // A checkout whose `.git` file points at a git dir beside it, relatively.
    await exec("git", ["-C", repo, "worktree", "add", "-q", join(root, "linked"), "-b", "side"]);
    await writeFile(join(root, "linked", ".git"), (await readFile(join(root, "linked", ".git"), "utf8")).replace(join(repo, ".git"), "../app/.git"));
    await syncProjectExcludes(root, ["linked"]);
    // The linked worktree's own git dir has no say over excludes; the common one does.
    expect(await readFile(join(repo, ".git", "info", "exclude"), "utf8")).toContain("node_modules/");
    await mkdir(join(root, "linked", "node_modules"), { recursive: true });
    await writeFile(join(root, "linked", "node_modules", "x.js"), "\n");
    expect(await sh(join(root, "linked"), "status", "--porcelain", "-uall")).toBe("");
});
