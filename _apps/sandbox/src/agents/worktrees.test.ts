import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gitInit } from "@intentic/scaffold";
import { afterEach, expect, test } from "vitest";
import { ensureRootRepo } from "../git/root-repo.js";
import { repoGitDir } from "../history/history.js";
import { createLogger } from "../logger.js";
import { workspacePaths } from "../workspace/workspace.js";
import { createAgentWorktrees } from "./worktrees.js";

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

// A production-shaped workspace: /work with a --separate-git-dir root repo (a committed baseline) and one
// nested "intent" role repo, real git dirs on the history volume — the layout worktrees must operate over.
const setup = async (): Promise<{ work: string; historyRoot: string; worktrees: ReturnType<typeof createAgentWorktrees> }> => {
    const base = await mkdtemp(join(tmpdir(), "intentic-worktrees-"));
    tempDirs.push(base);
    const work = join(base, "work");
    const historyRoot = join(base, "history");
    const workspace = workspacePaths(work);
    // The nested repo exists BEFORE the root repo is ensured (production boot order), so the root's derived
    // exclude list covers /intent/ and the baseline can't capture it.
    await mkdir(work, { recursive: true });
    const intent = join(workspace.root, "intent");
    await gitInit(intent, repoGitDir(historyRoot, "intent"));
    await writeFile(join(intent, "deploy.config.ts"), "v1\n");
    await sh(intent, "add", "-A");
    await sh(intent, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "intent v1");
    // The production root repo: --separate-git-dir on /history plus the derived exclude list.
    await ensureRootRepo(workspace, historyRoot);
    await writeFile(join(work, "CLAUDE.md"), "workspace notes\n");
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "baseline");
    const worktrees = createAgentWorktrees({ workspace, worktreesRoot: join(historyRoot, "worktrees"), logger });
    return { work, historyRoot, worktrees };
};

test("ensure creates the mirrored composition with agent branches and recorded bases", async () => {
    const { work, worktrees } = await setup();
    const conversation = await worktrees.ensure("c1", []);

    expect(conversation.branch).toBe("agent/c1");
    expect(conversation.repos.map((repo) => repo.repo).toSorted()).toEqual(["intent", "root"]);
    // The checkout mirrors /work: the root worktree holds the workspace files, the nested repo mounts inside.
    expect(await readFile(join(conversation.cwd, "CLAUDE.md"), "utf8")).toBe("workspace notes\n");
    expect(await readFile(join(conversation.cwd, "intent", "deploy.config.ts"), "utf8")).toBe("v1\n");
    expect(await sh(conversation.cwd, "branch", "--show-current")).toBe("agent/c1");
    // Bases are the mains' HEAD shas at creation.
    const rootBase = conversation.repos.find((repo) => repo.repo === "root")?.base;
    expect(rootBase).toBe(await sh(work, "rev-parse", "HEAD"));
});

test("worktree edits stay isolated from the main tree", async () => {
    const { work, worktrees } = await setup();
    const conversation = await worktrees.ensure("c1", []);
    await writeFile(join(conversation.cwd, "intent", "deploy.config.ts"), "agent edit\n");
    await writeFile(join(conversation.cwd, "new-file.md"), "agent file\n");

    expect(await sh(work, "status", "--porcelain")).toBe("");
    expect(await sh(join(work, "intent"), "status", "--porcelain")).toBe("");
    expect(existsSync(join(work, "new-file.md"))).toBe(false);
    expect(await readFile(join(work, "intent", "deploy.config.ts"), "utf8")).toBe("v1\n");
});

test("ensure with a recorded composition repairs a deleted .git pointer", async () => {
    const { worktrees } = await setup();
    const created = await worktrees.ensure("c1", []);
    await rm(join(created.cwd, ".git"));

    const repaired = await worktrees.ensure("c1", created.repos);
    expect(repaired.repos).toEqual(created.repos);
    expect(await sh(repaired.cwd, "branch", "--show-current")).toBe("agent/c1");
});

test("remove tears down worktrees and branches; prune sweeps orphan dirs", async () => {
    const { work, historyRoot, worktrees } = await setup();
    const conversation = await worktrees.ensure("c1", []);
    await worktrees.remove("c1", conversation.repos);

    expect(existsSync(conversation.cwd)).toBe(false);
    await expect(sh(work, "rev-parse", "-q", "--verify", "refs/heads/agent/c1")).rejects.toThrow();

    const orphan = join(historyRoot, "worktrees", "ghost");
    await mkdir(orphan, { recursive: true });
    await worktrees.prune(["kept"]);
    expect(existsSync(orphan)).toBe(false);
});

test("an unborn-HEAD repo is excluded from the composition", async () => {
    const { work, historyRoot, worktrees } = await setup();
    const empty = join(work, "empty-repo");
    await gitInit(empty, repoGitDir(historyRoot, "empty-repo"));

    const conversation = await worktrees.ensure("c1", []);
    expect(conversation.repos.map((repo) => repo.repo)).not.toContain("empty-repo");
    expect(existsSync(join(conversation.cwd, "empty-repo"))).toBe(false);
});
