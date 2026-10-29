import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createLogger } from "../../../logger.js";
import { BRANCH_CHECKOUT_IDLE_MS, type BranchCheckouts, createBranchCheckouts } from "./branch-checkouts.js";

// The checkouts the daemon keeps of branches the shared tree is not on (branch-checkouts.ts): laid out like /work,
// attached to their branch, never holding anything uncommitted, and gone once nobody needs them. Real git throughout,
// since what is under test is where each checkout and the shared tree stand.

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
const commit = (cwd: string, message: string): Promise<string> => sh(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message);
const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

const repoAt = async (dir: string, files: Record<string, string>): Promise<void> => {
    await mkdir(dir, { recursive: true });
    await sh(dir, "init", "-q", "-b", "main");
    for (const [name, text] of Object.entries(files)) {
        await writeFile(join(dir, name), text);
    }
    await sh(dir, "add", "-A");
    await commit(dir, "baseline");
};

// A workspace on `main` with a `feature` branch (README changed, gone.ts deleted) and a nested repo `libs/ui` with a
// `topic` branch.
const setup = async (): Promise<{ work: string; history: string; branches: BranchCheckouts }> => {
    const base = await mkdtemp(join(tmpdir(), "intentic-branches-"));
    tempDirs.push(base);
    const work = join(base, "work");
    const history = join(base, "history");
    await repoAt(work, { "README.md": "main\n", "gone.ts": "here on main\n", ".gitignore": "libs/\n" });
    await sh(work, "checkout", "-q", "-b", "feature");
    await writeFile(join(work, "README.md"), "feature\n");
    await sh(work, "rm", "-q", "gone.ts");
    await sh(work, "add", "-A");
    await commit(work, "feature work");
    await sh(work, "checkout", "-q", "main");
    const ui = join(work, "libs", "ui");
    await repoAt(ui, { "button.ts": "main button\n" });
    await sh(ui, "checkout", "-q", "-b", "topic");
    await writeFile(join(ui, "button.ts"), "topic button\n");
    await sh(ui, "add", "-A");
    await commit(ui, "topic work");
    await sh(ui, "checkout", "-q", "main");
    const branches = createBranchCheckouts({
        historyRoot: history,
        worktrees: { withRepoLock: (_repo, task) => task(), mainDir: (repo) => (repo === "root" ? work : join(work, repo)) },
        logger,
    });
    return { work, history, branches };
};

test("a branch is checked out beside the shared tree, attached to it, while the shared tree stays where it was", async () => {
    const { work, history, branches } = await setup();
    const dir = await branches.ensure("root", "feature");
    expect(dir).toBe(join(history, "branches", "root", "feature"));
    expect(await readFile(join(dir, "README.md"), "utf8")).toBe("feature\n");
    expect(await sh(dir, "symbolic-ref", "--short", "HEAD")).toBe("feature");
    expect(await sh(work, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(await readFile(join(work, "README.md"), "utf8")).toBe("main\n");
});

test("a nested repository's checkout sits where it does in /work, under a folder laid out like the workspace", async () => {
    const { history, branches } = await setup();
    const dir = await branches.ensure("libs/ui", "topic");
    const root = join(history, "branches", encodeURIComponent("libs/ui"), "topic");
    expect(branches.viewRoot("libs/ui", "topic")).toBe(root);
    expect(dir).toBe(join(root, "libs", "ui"));
    expect(await readFile(join(dir, "button.ts"), "utf8")).toBe("topic button\n");
});

test("a branch only origin has is made locally at origin's tip first, and checked out", async () => {
    const { work, branches } = await setup();
    const tip = await sh(work, "rev-parse", "feature");
    await sh(work, "update-ref", "refs/remotes/origin/remote-only", tip);
    const dir = await branches.ensure("root", "remote-only");
    expect(await sh(work, "rev-parse", "refs/heads/remote-only")).toBe(tip);
    expect(await sh(dir, "rev-parse", "HEAD")).toBe(tip);
});

test("the main line, an agent's own branch, a branch that is nowhere and a repository that is not there are refused", async () => {
    const { work, branches } = await setup();
    await sh(work, "branch", "agent/c1");
    await expect(branches.ensure("root", "main")).rejects.toThrow("main line");
    await expect(branches.ensure("root", "agent/c1")).rejects.toThrow("agent's own copy");
    await expect(branches.ensure("root", "nowhere")).rejects.toThrow("no branch `nowhere`");
    await expect(branches.ensure("libs/none", "topic")).rejects.toThrow("no repository");
    // Nothing was made for any of them.
    expect(await branches.standing()).toEqual([]);
});

test("refresh follows a branch that moved and puts back anything left in the checkout", async () => {
    const { work, branches } = await setup();
    const dir = await branches.refresh("root", "feature");
    // Moved by someone else (a fetch, another copy's push): the checkout's files follow on the next refresh.
    const moved = join(work, "..", "mover");
    await sh(work, "worktree", "add", "-q", "--detach", moved, "feature");
    await writeFile(join(moved, "README.md"), "feature, moved on\n");
    await sh(moved, "add", "-A");
    await commit(moved, "moved on");
    await sh(work, "update-ref", "refs/heads/feature", await sh(moved, "rev-parse", "HEAD"));
    await sh(work, "worktree", "remove", "--force", moved);
    expect(await branches.refresh("root", "feature")).toBe(dir);
    expect(await readFile(join(dir, "README.md"), "utf8")).toBe("feature, moved on\n");
    expect(await sh(dir, "status", "--porcelain")).toBe("");
    // Anything left in it (a land that died mid-write) is not anyone's work, and goes.
    await writeFile(join(dir, "README.md"), "half written\n");
    await writeFile(join(dir, "stray.ts"), "stray\n");
    await sh(work, "update-ref", "refs/heads/feature", await sh(work, "rev-parse", "feature~1"));
    await branches.refresh("root", "feature");
    expect(await readFile(join(dir, "README.md"), "utf8")).toBe("feature\n");
    await expect(stat(join(dir, "stray.ts"))).rejects.toThrow();
    expect(await sh(dir, "status", "--porcelain")).toBe("");
});

test("the sweep removes a checkout nobody lands onto or looked at for a week, never the branch, and keeps the rest", async () => {
    const { work, branches } = await setup();
    await branches.ensure("root", "feature");
    await branches.ensure("libs/ui", "topic");
    const weekAgo = new Date(Date.now() - BRANCH_CHECKOUT_IDLE_MS - 60_000);
    await utimes(branches.viewRoot("root", "feature"), weekAgo, weekAgo);
    await utimes(branches.viewRoot("libs/ui", "topic"), weekAgo, weekAgo);
    // `topic` is where a live conversation lands, so it stays however long nobody looked at it.
    const released = await branches.sweep(() => [{ repo: "libs/ui", branch: "topic" }]);
    expect(released).toEqual([{ repo: "root", branch: "feature" }]);
    expect(await branches.standing()).toEqual([{ repo: "libs/ui", branch: "topic" }]);
    expect(await sh(work, "rev-parse", "--verify", "refs/heads/feature")).not.toBe("");
    expect(await sh(work, "worktree", "list", "--porcelain")).not.toContain("feature");
    // A checkout looked at within the week stays too.
    await branches.ensure("root", "feature");
    expect(await branches.sweep(() => [{ repo: "libs/ui", branch: "topic" }])).toEqual([]);
});

test("a released checkout lets git delete its branch", async () => {
    const { work, branches } = await setup();
    await branches.ensure("root", "feature");
    await expect(sh(work, "branch", "-D", "feature")).rejects.toThrow();
    expect(await branches.release("root", "feature")).toBe(true);
    await sh(work, "branch", "-D", "feature");
    expect(await branches.release("root", "feature")).toBe(false);
});
