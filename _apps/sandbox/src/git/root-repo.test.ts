import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { ROOT_EXCLUDES } from "../history/history.js";
import { workspacePaths } from "../workspace/workspace.js";
import { changedFiles } from "./changes.js";
import { commitRootBaseline, ensureRootRepo } from "./root-repo.js";

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();

const tempDirs: string[] = [];
const tempBase = async (): Promise<{ work: string; historyRoot: string }> => {
    const base = await mkdtemp(join(tmpdir(), "intentic-root-repo-"));
    tempDirs.push(base);
    const work = join(base, "work");
    await mkdir(work, { recursive: true });
    return { work, historyRoot: join(base, "history") };
};
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

test("provision inits /work with a separate git dir, a baseline commit, and the history exclude list", async () => {
    const { work, historyRoot } = await tempBase();
    await writeFile(join(work, "notes.md"), "hello\n");
    await mkdir(join(work, "repositories", "intent"), { recursive: true });
    await writeFile(join(work, "repositories", "intent", "deploy.config.ts"), "v1\n");
    await mkdir(join(work, ".intentic"), { recursive: true });
    await writeFile(join(work, ".intentic", "owner.json"), "{}\n");

    expect(await ensureRootRepo(workspacePaths(work), historyRoot)).toBe(true);
    await commitRootBaseline(workspacePaths(work));

    // Pointer file in the worktree, real git dir on the history volume, excludes converged.
    expect(await readFile(join(work, ".git"), "utf8")).toBe(`gitdir: ${join(historyRoot, "gits", "root")}\n`);
    expect(await readFile(join(historyRoot, "gits", "root", "info", "exclude"), "utf8")).toBe(`${ROOT_EXCLUDES.join("\n")}\n`);
    // The baseline commit captured the loose file but neither repositories/ nor .intentic/.
    expect(await sh(work, "ls-files")).toBe("notes.md");
    expect((await changedFiles(work)).changes).toEqual([]);
});

test("daemon-owned skill files converged before the baseline read clean", async () => {
    const { work, historyRoot } = await tempBase();

    expect(await ensureRootRepo(workspacePaths(work), historyRoot)).toBe(true);
    // The boot sequence converges .claude skills (e.g. the drafts skill) BEFORE committing the baseline.
    await mkdir(join(work, ".claude", "skills", "drafts"), { recursive: true });
    await writeFile(join(work, ".claude", "skills", "drafts", "SKILL.md"), "converged\n");
    await commitRootBaseline(workspacePaths(work));

    expect(await sh(work, "ls-files")).toBe(".claude/skills/drafts/SKILL.md");
    expect((await changedFiles(work)).changes).toEqual([]);
});

test("re-ensure is idempotent and heals a deleted .git pointer without a new baseline", async () => {
    const { work, historyRoot } = await tempBase();
    expect(await ensureRootRepo(workspacePaths(work), historyRoot)).toBe(true);
    await commitRootBaseline(workspacePaths(work));
    const head = await sh(work, "rev-parse", "HEAD");

    await rm(join(work, ".git"));
    expect(await ensureRootRepo(workspacePaths(work), historyRoot)).toBe(false);
    expect(await sh(work, "rev-parse", "HEAD")).toBe(head);
    expect(await sh(work, "log", "--format=%s")).toBe("Initialize workspace");
});
