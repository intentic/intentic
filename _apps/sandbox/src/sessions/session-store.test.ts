import { lstat, mkdir, mkdtemp, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { linkClaudeProjects } from "./session-store.js";

const roots: string[] = [];
const scratch = async (): Promise<{ home: string; work: string }> => {
    const root = await mkdtemp(join(tmpdir(), "session-store-"));
    roots.push(root);
    return { home: join(root, "home"), work: join(root, "work") };
};

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("links ~/.claude/projects to the workspace store, creating both ends", async () => {
    const { home, work } = await scratch();
    await linkClaudeProjects(work, home);
    expect(await readlink(join(home, ".claude", "projects"))).toBe(join(work, ".intentic", "claude", "projects"));
    expect((await lstat(join(work, ".intentic", "claude", "projects"))).isDirectory()).toBe(true);
});

test("a second run (daemon restart in the same container) is a no-op", async () => {
    const { home, work } = await scratch();
    await linkClaudeProjects(work, home);
    await linkClaudeProjects(work, home);
    expect(await readlink(join(home, ".claude", "projects"))).toBe(join(work, ".intentic", "claude", "projects"));
});

test("a real projects directory (a dev-host run) throws and is left intact", async () => {
    const { home, work } = await scratch();
    const projects = join(home, ".claude", "projects");
    await mkdir(projects, { recursive: true });
    await writeFile(join(projects, "real.jsonl"), "{}");
    await expect(linkClaudeProjects(work, home)).rejects.toThrow("not a symlink");
    expect((await lstat(projects)).isSymbolicLink()).toBe(false);
    expect((await lstat(join(projects, "real.jsonl"))).isFile()).toBe(true);
});
