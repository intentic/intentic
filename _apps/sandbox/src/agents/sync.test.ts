import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { ensureRootRepo } from "../git/root-repo.js";
import { createLogger } from "../logger.js";
import { createPerfTracker } from "../platform/perf.js";
import { workspacePaths } from "../workspace/workspace.js";
import { landAgent } from "./land.js";
import { syncConversation } from "./sync.js";
import { createAgentWorktrees, type AgentWorktrees } from "./worktrees.js";

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
const commit = (cwd: string, message: string): Promise<string> => sh(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message);
const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });
const perf = createPerfTracker(logger);
const noIsolation = { available: async () => false, planFor: async () => undefined };

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

// A workspace whose root repo holds two files, and one conversation branched off it. `app.ts` is the file both
// sides fight over; `other.ts` is what the main line moves without the agent noticing.
const setup = async (): Promise<{ work: string; worktree: string; worktrees: AgentWorktrees }> => {
    const base = await mkdtemp(join(tmpdir(), "intentic-sync-"));
    tempDirs.push(base);
    const work = join(base, "work");
    const workspace = workspacePaths(work);
    await mkdir(work, { recursive: true });
    await ensureRootRepo(workspace, join(base, "history"));
    await writeFile(join(work, "app.ts"), "one\ntwo\nthree\nfour\nfive\n");
    await writeFile(join(work, "other.ts"), "untouched\n");
    await sh(work, "add", "-A");
    await commit(work, "baseline");
    const worktrees = createAgentWorktrees({
        workspace,
        worktreesRoot: join(base, "history", "worktrees"),
        historyRoot: join(base, "history"),
        isolation: noIsolation,
        logger,
        perf,
    });
    await worktrees.ensure("c1", []);
    return { work, worktree: worktrees.worktreeDir("c1", "root"), worktrees };
};

const sync = (worktrees: AgentWorktrees): ReturnType<typeof syncConversation> => syncConversation(worktrees, "c1", [{ repo: "root" }], "fix the thing");

test("reports nothing when the branch already sits on the main line", async () => {
    const { worktrees } = await setup();
    expect(await sync(worktrees)).toEqual([]);
});

test("replays the agent's commits onto a main line that moved, and says what moved", async () => {
    const { work, worktree, worktrees } = await setup();
    // The agent edits the last line of app.ts and commits.
    await writeFile(join(worktree, "app.ts"), "one\ntwo\nthree\nfour\nAGENT\n");
    await sh(worktree, "add", "-A");
    await commit(worktree, "agent work");
    // The user, meanwhile, edits the FIRST line of the same file and adds a second commit elsewhere.
    await writeFile(join(work, "app.ts"), "USER\ntwo\nthree\nfour\nfive\n");
    await sh(work, "add", "-A");
    await commit(work, "user work");
    await writeFile(join(work, "other.ts"), "moved\n");
    await sh(work, "add", "-A");
    await commit(work, "unrelated");

    const [root] = await sync(worktrees);
    expect(root).toMatchObject({ repo: "root", commits: 2, moved: ["app.ts", "other.ts"], overlap: ["app.ts"] });
    expect(root?.blocked).toBeUndefined();
    expect(root?.onto).toBe(await sh(work, "rev-parse", "HEAD"));
    // Both sides survive: the user's first line and the agent's last one, in one file.
    expect(await readFile(join(worktree, "app.ts"), "utf8")).toBe("USER\ntwo\nthree\nfour\nAGENT\n");
    // And the branch really is on top of the main line now, not merely holding its content.
    expect(await sh(worktree, "rev-list", "--count", `${await sh(work, "rev-parse", "HEAD")}..HEAD`)).toBe("1");
});

test("commits the worktree's dirty remainder first — a rebase refuses to start otherwise", async () => {
    const { work, worktree, worktrees } = await setup();
    // An interrupted turn's leftovers: edited and never committed.
    await writeFile(join(worktree, "app.ts"), "one\ntwo\nthree\nfour\nAGENT\n");
    await writeFile(join(worktree, "new.ts"), "brand new\n");
    await writeFile(join(work, "other.ts"), "moved\n");
    await sh(work, "add", "-A");
    await commit(work, "user work");

    const [root] = await sync(worktrees);
    expect(root?.blocked).toBeUndefined();
    expect(await sh(worktree, "status", "--porcelain")).toBe("");
    expect(await readFile(join(worktree, "app.ts"), "utf8")).toBe("one\ntwo\nthree\nfour\nAGENT\n");
    expect(await readFile(join(worktree, "new.ts"), "utf8")).toBe("brand new\n");
    // The remainder is provenance, carrying the agent title and the daemon's identity — land's own commit.
    expect(await sh(worktree, "log", "-1", "--format=%s%n%an")).toBe("Agent: fix the thing\nintentic");
});

test("rolls a conflicting rebase back and leaves the branch on its old base", async () => {
    const { work, worktree, worktrees } = await setup();
    const before = await sh(worktree, "rev-parse", "HEAD");
    // Both sides rewrite the SAME line — nothing git can replay.
    await writeFile(join(worktree, "app.ts"), "one\ntwo\nAGENT\nfour\nfive\n");
    await sh(worktree, "add", "-A");
    await commit(worktree, "agent work");
    await writeFile(join(work, "app.ts"), "one\ntwo\nUSER\nfour\nfive\n");
    await sh(work, "add", "-A");
    await commit(work, "user work");

    const [root] = await sync(worktrees);
    expect(root).toMatchObject({ repo: "root", blocked: true, commits: 1, overlap: ["app.ts"] });
    // Rolled all the way back: no rebase in progress, the agent's own commit still on top of its old base, and
    // its content untouched. This is the state the turn runs in — exactly today's behaviour, nothing worse.
    expect(await sh(worktree, "status", "--porcelain")).toBe("");
    expect(await sh(worktree, "rev-parse", "HEAD^")).toBe(before);
    expect(await readFile(join(worktree, "app.ts"), "utf8")).toBe("one\ntwo\nAGENT\nfour\nfive\n");
});

test("leaves a retired checkout alone", async () => {
    const { work, worktrees } = await setup();
    await worktrees.retire("c1", [{ repo: "root", base: await sh(work, "rev-parse", "HEAD") }], "fix the thing");
    await writeFile(join(work, "other.ts"), "moved\n");
    await sh(work, "add", "-A");
    await commit(work, "user work");
    expect(await sync(worktrees)).toEqual([]);
});

test("a synced branch still lands only its own work", async () => {
    const { work, worktree, worktrees } = await setup();
    const base = await sh(work, "rev-parse", "HEAD");
    await writeFile(join(worktree, "app.ts"), "one\ntwo\nthree\nfour\nAGENT\n");
    await sh(worktree, "add", "-A");
    await commit(worktree, "agent work");
    // The main line gains a file the agent has never seen. A land measured from the FROZEN base would carry it
    // back as the agent's own work and fail to apply; measured from the merge-base it is simply not in the span.
    await writeFile(join(work, "other.ts"), "moved\n");
    await sh(work, "add", "-A");
    await commit(work, "user work");

    await sync(worktrees);
    const entry = {
        id: "c1",
        branch: "agent/c1",
        title: "fix the thing",
        provider: "claude" as const,
        harness: "native" as const,
        isolated: true as const,
        repos: [{ repo: "root", base }],
        status: "idle" as const,
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        createdAt: 0,
        updatedAt: 0,
    };
    const outcome = await landAgent(worktrees, entry);
    expect(outcome.landed).toBe(true);
    expect(outcome.diff.files).toBe(1);
    expect(await readFile(join(work, "app.ts"), "utf8")).toBe("one\ntwo\nthree\nfour\nAGENT\n");
    expect(await readFile(join(work, "other.ts"), "utf8")).toBe("moved\n");
});
