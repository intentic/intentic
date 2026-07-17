import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { ensureRootRepo } from "../git/root-repo.js";
import { createLogger } from "../logger.js";
import { workspacePaths } from "../workspace/workspace.js";
import type { PersistedAgent } from "./agents-store.js";
import { landAgent } from "./land.js";
import { createAgentWorktrees, type AgentWorktrees, type ConversationWorktree } from "./worktrees.js";

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

const setup = async (): Promise<{ work: string; worktrees: AgentWorktrees; conversation: ConversationWorktree }> => {
    const base = await mkdtemp(join(tmpdir(), "intentic-land-"));
    tempDirs.push(base);
    const work = join(base, "work");
    const historyRoot = join(base, "history");
    const workspace = workspacePaths(work);
    await mkdir(work, { recursive: true });
    await ensureRootRepo(workspace, historyRoot);
    await writeFile(join(work, "app.ts"), "v1\n");
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "baseline");
    const worktrees = createAgentWorktrees({ workspace, worktreesRoot: join(historyRoot, "worktrees"), logger });
    const conversation = await worktrees.ensure("c1", []);
    return { work, worktrees, conversation };
};

const entryFor = (conversation: ConversationWorktree): PersistedAgent => ({
    id: "c1",
    branch: "agent/c1",
    title: "fix the thing",
    provider: "claude",
    harness: "native",
    repos: [...conversation.repos],
    status: "idle",
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    createdAt: 0,
    updatedAt: 0,
});

test("land commits worktree WIP and fast-forwards the main tree", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), "agent v2\n");
    await writeFile(join(conversation.cwd, "added.ts"), "new file\n");

    const result = await landAgent(worktrees, entryFor(conversation));
    expect(result).toEqual({ landed: true });
    expect(await readFile(join(work, "app.ts"), "utf8")).toBe("agent v2\n");
    expect(await readFile(join(work, "added.ts"), "utf8")).toBe("new file\n");
    expect(await sh(work, "log", "-1", "--format=%s %an")).toBe("Agent: fix the thing intentic");
    // The worktree survives — the conversation can keep working and land incrementally.
    await writeFile(join(conversation.cwd, "app.ts"), "agent v3\n");
    expect(await landAgent(worktrees, entryFor(conversation))).toEqual({ landed: true });
    expect(await readFile(join(work, "app.ts"), "utf8")).toBe("agent v3\n");
});

test("land with nothing changed is a clean no-op", async () => {
    const { work, worktrees, conversation } = await setup();
    const head = await sh(work, "rev-parse", "HEAD");
    expect(await landAgent(worktrees, entryFor(conversation))).toEqual({ landed: true });
    expect(await sh(work, "rev-parse", "HEAD")).toBe(head);
});

test("overlapping dirty main paths are reported, not merged; disjoint dirty paths survive a land", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), "agent version\n");
    await writeFile(join(work, "app.ts"), "user uncommitted\n"); // overlap
    await writeFile(join(work, "notes.md"), "user notes\n"); // disjoint

    const first = await landAgent(worktrees, entryFor(conversation));
    expect(first.landed).toBe(false);
    expect(first.conflicts).toEqual([{ repo: "root", paths: ["app.ts"] }]);
    expect(await readFile(join(work, "app.ts"), "utf8")).toBe("user uncommitted\n");

    // User resolves their edit (reverts it); the disjoint dirty file must ride through the merge untouched.
    await sh(work, "checkout", "--", "app.ts");
    const second = await landAgent(worktrees, entryFor(conversation));
    expect(second).toEqual({ landed: true });
    expect(await readFile(join(work, "app.ts"), "utf8")).toBe("agent version\n");
    expect(await readFile(join(work, "notes.md"), "utf8")).toBe("user notes\n");
});

test("a real merge conflict aborts cleanly and reports the unmerged paths", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), "agent line\n");
    // Main advances with a COMMITTED conflicting change — a genuine divergence, not just dirt.
    await writeFile(join(work, "app.ts"), "main line\n");
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "main advance");
    const mainHead = await sh(work, "rev-parse", "HEAD");

    const result = await landAgent(worktrees, entryFor(conversation));
    expect(result.landed).toBe(false);
    expect(result.conflicts).toEqual([{ repo: "root", paths: ["app.ts"] }]);
    // merge --abort left main exactly where it was, mid-merge state gone.
    expect(await sh(work, "rev-parse", "HEAD")).toBe(mainHead);
    expect(await sh(work, "status", "--porcelain")).toBe("");
    // The agent's work is intact on its branch.
    expect(await readFile(join(conversation.cwd, "app.ts"), "utf8")).toBe("agent line\n");
});
