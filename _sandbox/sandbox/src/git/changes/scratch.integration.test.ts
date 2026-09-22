import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { test, expect, afterEach } from "bun:test";
import { OVERSIZED_BYTES, scratchOf, scratchScopeOf, withScratchExcluded } from "./scratch.js";

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

// A committed repo holding `src/app.ts`, `docs/guide.md` and a `.gitignore` that ignores `*.secret`.
const tempRepo = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "intentic-scratch-"));
    tempDirs.push(dir);
    await sh(dir, "init", "-q", "--initial-branch=main");
    await put(dir, "src/app.ts", "export {};\n");
    await put(dir, "docs/guide.md", "# guide\n");
    await put(dir, ".gitignore", "*.secret\n");
    await sh(dir, "add", "-A");
    await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base");
    return dir;
};

const put = async (dir: string, path: string, content: string): Promise<void> => {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
};

const PROJECT = { root: false, container: false } as const;
const ROOT = { root: true, container: false } as const;
const WORKSPACE = { root: true, container: true } as const;

test("a new hidden directory is scratch whole, counted, whatever it is called", async () => {
    const dir = await tempRepo();
    await put(dir, ".trun/final.log", "12345");
    await put(dir, ".trun/run.sh", "echo hi\n");
    await put(dir, ".agent-htw8/probe.test.ts", "x");

    expect(await scratchOf(dir, PROJECT)).toEqual([
        { path: ".agent-htw8/", reason: "hidden", files: 1, bytes: 1 },
        { path: ".trun/", reason: "hidden", files: 2, bytes: 13 },
    ]);
});

test("a hidden directory a project keeps on purpose is carried", async () => {
    const dir = await tempRepo();
    await put(dir, ".github/workflows/ci.yml", "on: push\n");
    await put(dir, ".changeset/brave-owls.md", "---\n---\n");

    expect(await scratchOf(dir, PROJECT)).toEqual([]);
});

test("by-products are scratch one by one, in old directories and new ones alike", async () => {
    const dir = await tempRepo();
    await put(dir, "src/debug.log", "log");
    await put(dir, "src/app.ts.orig", "old");
    await put(dir, "src/feature/index.ts", "export {};\n");
    await put(dir, "src/feature/trace.LOG", "trace");
    await put(dir, "src/.DS_Store", "");

    expect((await scratchOf(dir, PROJECT)).map(({ path, reason }) => [path, reason])).toEqual([
        ["src/.DS_Store", "byproduct"],
        ["src/app.ts.orig", "byproduct"],
        ["src/debug.log", "byproduct"],
        ["src/feature/trace.LOG", "byproduct"],
    ]);
});

test("a hidden directory inside a new one is scratch, and the new one's other files are carried", async () => {
    const dir = await tempRepo();
    await put(dir, "packages/tool/index.ts", "export {};\n");
    await put(dir, "packages/tool/.cache/state.json", "{}");
    await put(dir, "packages/tool/.cache/more/deep.json", "{}");

    expect(await scratchOf(dir, PROJECT)).toEqual([{ path: "packages/tool/.cache/", reason: "hidden", files: 2, bytes: 4 }]);
});

test("a checkout of its own is scratch in the workspace's root repo, and not walked", async () => {
    const dir = await tempRepo();
    await put(dir, "vendor/notes.md", "keep me\n");
    await put(dir, "vendor/lib/readme.md", "clone\n");
    await sh(join(dir, "vendor/lib"), "init", "-q");

    expect(await scratchOf(dir, ROOT)).toEqual([{ path: "vendor/lib/", reason: "checkout" }]);
});

// A project repo records a nested repository as a gitlink, which may be its owner's submodule in the making.
test("a checkout inside a project repo is carried as the project's own business", async () => {
    const dir = await tempRepo();
    await put(dir, "vendor/lib/readme.md", "clone\n");
    await sh(join(dir, "vendor/lib"), "init", "-q");

    expect(await scratchOf(dir, PROJECT)).toEqual([]);
});

test("a new file past the size source reaches is scratch", async () => {
    const dir = await tempRepo();
    await put(dir, "data/dump.json", "");
    // Sparse: the size is what is judged, and a real 50 MiB write would cost the suite for nothing.
    await truncate(join(dir, "data/dump.json"), OVERSIZED_BYTES + 1);
    await put(dir, "data/small.json", "{}");

    expect(await scratchOf(dir, PROJECT)).toEqual([{ path: "data/dump.json", reason: "oversized", files: 1, bytes: OVERSIZED_BYTES + 1 }]);
});

test("staged paths are somebody's decision and ignored paths were never candidates", async () => {
    const dir = await tempRepo();
    await put(dir, ".keep/wanted.log", "yes");
    await sh(dir, "add", ".keep/wanted.log");
    await put(dir, "src/key.secret", "ignored");

    expect(await scratchOf(dir, PROJECT)).toEqual([]);
});

// A dotfile configures the project it sits in, and a workspace root holding repositories is not one.
test("at a workspace root holding repositories, a new dotfile at the top is scratch and visible files are work", async () => {
    const dir = await tempRepo();
    await put(dir, ".task-ps.txt", "scratch");
    await put(dir, ".mcp.json", "{}");
    await put(dir, "report.md", "# the answer\n");
    await put(dir, "bench/run.py", "print()\n");
    await put(dir, ".claude/skills/one/SKILL.md", "---\n---\n");

    expect((await scratchOf(dir, WORKSPACE)).map(({ path, reason }) => [path, reason])).toEqual([[".task-ps.txt", "root"]]);
    expect(await scratchOf(dir, PROJECT)).toEqual([]);
});

test("a workspace root is a container only while it holds a repository, and only the root repo is one", async () => {
    const dir = await tempRepo();
    expect(await scratchScopeOf("root", dir)).toEqual({ root: true, container: false });

    await mkdir(join(dir, "app"), { recursive: true });
    await sh(join(dir, "app"), "init", "-q");

    expect(await scratchScopeOf("root", dir)).toEqual({ root: true, container: true });
    expect(await scratchScopeOf("app", dir)).toEqual({ root: false, container: false });
});

test("a stage-everything with the scratch excluded never stages it, and stages the rest, deletions included", async () => {
    const dir = await tempRepo();
    await put(dir, ".trun/x.log", "log");
    await put(dir, "we[ir]d/f*.log", "glob-shaped");
    await put(dir, "src/feature.ts", "export {};\n");
    await rm(join(dir, "docs/guide.md"));
    const scratch = await scratchOf(dir, PROJECT);

    await withScratchExcluded(scratch, (pathspecArgs) => exec("git", ["-C", dir, "add", "-A", ...pathspecArgs]));

    expect(await sh(dir, "status", "--porcelain", "-uall")).toBe(["D  docs/guide.md", "A  src/feature.ts", "?? .trun/x.log", "?? we[ir]d/f*.log"].join("\n"));
});
