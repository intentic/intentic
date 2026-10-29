import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { OffMainLineError } from "../../../git/main-line-lock.js";
import { createLogger } from "../../../logger.js";
import { createPerfTracker } from "../../../system/resources/perf.js";
import { workspacePaths } from "../../../workspace/workspace.js";
import { isolatedAgent } from "../../registry/agents-store.testing.js";
import { noIsolation } from "../../worktrees/isolation.testing.js";
import { createAgentWorktrees, type AgentWorktrees } from "../../worktrees/worktrees.js";
import { landFailureOf } from "../land-failure.js";
import { landAgent } from "../land.js";
import { syncConversation } from "../sync.js";

// THE SAFETY NET UNDER THE MAIN-LINE LOCK (git/main-line-lock.ts). Every door keeps the shared checkout on its main
// line; when something went around them anyway, a conversation is still cut from and synced onto the main line's own
// tip, never the branch the checkout was moved to, and a land waits rather than write onto that branch.

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
const commit = (cwd: string, message: string): Promise<string> => sh(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message);
const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });
const perf = createPerfTracker(logger);

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

// A shared checkout on `main` with a `side` branch one commit ahead of it, and a conversation cut while it stood on main.
const setup = async (): Promise<{ work: string; worktrees: AgentWorktrees; main: string; side: string }> => {
    const base = await mkdtemp(join(tmpdir(), "intentic-off-line-"));
    tempDirs.push(base);
    const work = join(base, "work");
    const historyRoot = join(base, "history");
    await mkdir(work, { recursive: true });
    await sh(work, "init", "-q", "-b", "main");
    await writeFile(join(work, "app.ts"), "one\n");
    await sh(work, "add", "-A");
    const main = (await commit(work, "baseline"), await sh(work, "rev-parse", "HEAD"));
    await sh(work, "checkout", "-q", "-b", "side");
    await writeFile(join(work, "side.ts"), "only on the side branch\n");
    await sh(work, "add", "-A");
    await commit(work, "side work");
    const side = await sh(work, "rev-parse", "HEAD");
    await sh(work, "checkout", "-q", "main");
    const worktrees = createAgentWorktrees({
        workspace: workspacePaths(work),
        worktreesRoot: join(historyRoot, "worktrees"),
        historyRoot,
        isolation: noIsolation(work, historyRoot),
        logger,
        perf,
    });
    return { work, worktrees, main, side };
};

// What bypasses every door: a raw checkout of the shared tree.
const moveOffLine = (work: string): Promise<string> => sh(work, "checkout", "-q", "side");

test("a conversation opened while the shared checkout stands off its line is cut from the main line's tip", async () => {
    const { work, worktrees, main } = await setup();
    // Asked once on the line, as the daemon's first look does, so the lock is latched before anything moves it.
    await worktrees.ensure("c0", []);
    await moveOffLine(work);
    const conversation = await worktrees.ensure("c1", []);
    expect(conversation.repos).toEqual([{ repo: "root", base: main }]);
    expect(await sh(worktrees.worktreeDir("c1", "root"), "rev-parse", "HEAD")).toBe(main);
});

test("a sync while the shared checkout stands off its line goes onto the main line, not the branch it was moved to", async () => {
    const { work, worktrees, main } = await setup();
    await worktrees.ensure("c1", []);
    await writeFile(join(work, "app.ts"), "one\ntwo\n");
    await sh(work, "add", "-A");
    await commit(work, "main moves on");
    const moved = await sh(work, "rev-parse", "HEAD");
    expect(moved).not.toBe(main);
    await moveOffLine(work);
    const synced = await syncConversation(worktrees, "c1", [{ repo: "root" }], "fix the thing");
    expect(synced.map(({ onto }) => onto)).toEqual([moved]);
    const worktree = worktrees.worktreeDir("c1", "root");
    expect(await sh(worktree, "rev-parse", "HEAD")).toBe(moved);
    // Nothing of the side branch came along.
    await expect(readFile(join(worktree, "side.ts"), "utf8")).rejects.toThrow();
});

test("a land into a shared checkout moved off its line writes nothing and says why, by its own kind", async () => {
    const { work, worktrees } = await setup();
    const conversation = await worktrees.ensure("c1", []);
    await writeFile(join(conversation.cwd, "app.ts"), "one\nagent\n");
    await moveOffLine(work);
    const failure = await landAgent(worktrees, isolatedAgent(conversation.repos)).then(
        () => undefined,
        (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(OffMainLineError);
    expect(landFailureOf(failure)).toMatchObject({ code: "off_main_line" });
    expect(String(failure)).toContain("`side`, not `main`");
    // The checkout it would have written into is exactly as the move left it.
    expect(await readFile(join(work, "app.ts"), "utf8")).toBe("one\n");
    expect(await sh(work, "status", "--porcelain")).toBe("");
    // Back on its line, the same land goes through.
    await sh(work, "checkout", "-q", "main");
    const landed = await landAgent(worktrees, isolatedAgent(conversation.repos));
    expect(landed.landed).toBe(true);
    expect(await readFile(join(work, "app.ts"), "utf8")).toBe("one\nagent\n");
});
