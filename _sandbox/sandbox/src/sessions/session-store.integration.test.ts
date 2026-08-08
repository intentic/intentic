import { lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { linkClaudeState } from "./session-store.js";

const roots: string[] = [];
const scratch = async (): Promise<{ home: string; work: string }> => {
    const root = await mkdtemp(join(tmpdir(), "session-store-"));
    roots.push(root);
    return { home: join(root, "home"), work: join(root, "work") };
};

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("links every conversation-owned ~/.claude store to the workspace, creating both ends", async () => {
    const { home, work } = await scratch();
    await linkClaudeState(work, home);
    for (const name of ["projects", "plans", "backups", "tasks", "sessions", "session-env", "shell-snapshots", "todos"]) {
        expect(await readlink(join(home, ".claude", name))).toBe(join(work, ".intentic", "sessions", "claude", name));
        expect((await lstat(join(work, ".intentic", "sessions", "claude", name))).isDirectory()).toBe(true);
    }
});

test("a second run (daemon restart in the same container) is a no-op", async () => {
    const { home, work } = await scratch();
    await linkClaudeState(work, home);
    await linkClaudeState(work, home);
    expect(await readlink(join(home, ".claude", "projects"))).toBe(join(work, ".intentic", "sessions", "claude", "projects"));
});

test("a real directory (a dev-host run) throws, is left intact, and does not block the other links", async () => {
    const { home, work } = await scratch();
    const projects = join(home, ".claude", "projects");
    await mkdir(projects, { recursive: true });
    await writeFile(join(projects, "real.jsonl"), "{}");
    await expect(linkClaudeState(work, home)).rejects.toThrow("not symlinks");
    expect((await lstat(projects)).isSymbolicLink()).toBe(false);
    expect((await lstat(join(projects, "real.jsonl"))).isFile()).toBe(true);
    // The refusal is per entry: every other store still converged onto the workspace.
    expect(await readlink(join(home, ".claude", "plans"))).toBe(join(work, ".intentic", "sessions", "claude", "plans"));
});

const settingsOf = async (home: string): Promise<Record<string, unknown>> =>
    JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf8"));

// Without this the 30-day default sweep is the one thing left that deletes a persisted transcript.
test("holds the transcript sweep off the workspace store with a long retention window", async () => {
    const { home, work } = await scratch();
    await linkClaudeState(work, home);
    // Long, not zero: the CLI rejects 0 outright, so a "never" written that way would fail the whole settings load.
    expect(await settingsOf(home)).toEqual({ cleanupPeriodDays: 3650 });
});

test("merges into existing user settings rather than replacing them", async () => {
    const { home, work } = await scratch();
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(home, ".claude", "settings.json"), JSON.stringify({ model: "opus", cleanupPeriodDays: 30 }));
    await linkClaudeState(work, home);
    expect(await settingsOf(home)).toEqual({ model: "opus", cleanupPeriodDays: 3650 });
});

// A store we did not take over is someone else's ~/.claude — its retention is not ours to rewrite.
test("leaves retention alone when a store was refused", async () => {
    const { home, work } = await scratch();
    await mkdir(join(home, ".claude", "projects"), { recursive: true });
    await expect(linkClaudeState(work, home)).rejects.toThrow("not symlinks");
    await expect(readFile(join(home, ".claude", "settings.json"), "utf8")).rejects.toThrow("ENOENT");
});
