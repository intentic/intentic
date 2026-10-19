import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ensureRootRepo } from "../../git/remote/root-repo.js";
import { createLogger } from "../../logger.js";
import { createPerfTracker } from "../../system/resources/perf.js";
import { isolatedAgent } from "../../conversations/registry/agents-store.testing.js";
import { noIsolation } from "../../conversations/worktrees/isolation.testing.js";
import { createAgentWorktrees } from "../../conversations/worktrees/worktrees.js";
import { workspacePaths } from "../../workspace/workspace.js";
import { freshScopeOf, rangeCommand } from "./fresh-session.js";

// Against real git: the range a fresh session is told to read, run in its own checkout cut from the origin's work, is
// exactly the origin's change, committed and uncommitted alike, and nothing of the main line under it.

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
const commit = (cwd: string, message: string): Promise<string> => git(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-am", message);
const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

test("a fresh session cut from an origin's work reads that work, and only that, through the range it is told", async () => {
    const base = await mkdtemp(join(tmpdir(), "intentic-fresh-"));
    tempDirs.push(base);
    const work = join(base, "work");
    const historyRoot = join(base, "history");
    const workspace = workspacePaths(work);
    await mkdir(work, { recursive: true });
    await ensureRootRepo(workspace, historyRoot);
    await writeFile(join(work, "app.ts"), "one\n");
    await writeFile(join(work, "other.ts"), "two\n");
    await git(work, "add", "-A");
    await git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "baseline");
    const worktrees = createAgentWorktrees({
        workspace,
        worktreesRoot: join(historyRoot, "worktrees"),
        historyRoot,
        isolation: noIsolation(work, historyRoot),
        logger,
        perf: createPerfTracker(logger),
    });
    const origin = await worktrees.ensure("origin-1", []);
    const originDir = worktrees.worktreeDir("origin-1", "root");
    await writeFile(join(originDir, "app.ts"), "one EDITED\n");
    // The cut commits the origin's remainder before the fresh session's checkout is pinned to it (conversation-context.ts).
    await commit(originDir, "Agent: before starting review-1");
    // Main moves on meanwhile: none of it is the origin's work.
    await writeFile(join(work, "other.ts"), "two MAIN\n");
    await commit(work, "main moved");
    const cut = await git(originDir, "rev-parse", "HEAD");
    const fresh = await worktrees.ensure("review-1", [], [{ repo: "root", base: cut }]);

    const entries = [
        isolatedAgent(origin.repos, { id: "origin-1", social: { title: { text: "Edit the app", source: "derived" }, reactions: [] } }),
        isolatedAgent(fresh.repos, {
            id: "review-1",
            identity: { startedBy: "agent:origin-1", fresh: { of: "origin-1", kind: "review", at: 1 } },
            placement: { kind: "worktree", branch: "agent/review-1", repos: [...fresh.repos], parent: "origin-1" },
        }),
    ];
    const scope = await freshScopeOf({ agents: { entry: (id) => entries.find((entry) => entry.id === id) }, agentWorktrees: worktrees, logger }, "review-1");

    expect(scope).toMatchObject({ origin: { id: "origin-1", title: "Edit the app" }, kind: "review", cut: true });
    expect(scope?.ranges.map((range) => range.repo)).toEqual(["root"]);
    const [command = "", ...args] = rangeCommand(scope!.ranges[0]!).split(" ");
    const diff = (await exec(command, ["-C", worktrees.worktreeDir("review-1", "root"), ...args])).stdout;
    expect(diff).toContain("+one EDITED");
    expect(diff).not.toContain("MAIN");
});
