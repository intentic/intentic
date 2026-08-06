import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { rootExcludes } from "../history/history.js";
import { workspacePaths } from "../workspace/workspace.js";
import { changedFiles } from "./changes.js";
import { commitRootBaseline, commitWorktreeRemainder, ensureRootRepo } from "./root-repo.js";

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();

// These assertions only care that the tree is clean overall — which side a change would have landed on is
// changes.integration.test.ts's subject, not this file's.
const bothSides = async (dir: string): Promise<unknown[]> => {
    const { staged, unstaged } = await changedFiles(dir);
    return [...staged, ...unstaged];
};

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
    await mkdir(join(work, "intent", ".git"), { recursive: true });
    await writeFile(join(work, "intent", "deploy.config.ts"), "v1\n");
    await mkdir(join(work, ".intentic"), { recursive: true });
    await writeFile(join(work, ".intentic", "owner.json"), "{}\n");

    expect(await ensureRootRepo(workspacePaths(work), historyRoot)).toBe(true);
    await commitRootBaseline(workspacePaths(work));

    // Pointer file in the worktree, real git dir on the history volume, excludes converged from the
    // discovered repo set.
    expect(await readFile(join(work, ".git"), "utf8")).toBe(`gitdir: ${join(historyRoot, "gits", "root")}\n`);
    expect(await readFile(join(historyRoot, "gits", "root", "info", "exclude"), "utf8")).toBe(`${rootExcludes(["intent"]).join("\n")}\n`);
    // The baseline commit captured the loose file but neither the repo dir nor .intentic/.
    expect(await sh(work, "ls-files")).toBe("notes.md");
    expect(await bothSides(work)).toEqual([]);
});

test("daemon-owned skill files converged before the baseline read clean", async () => {
    const { work, historyRoot } = await tempBase();

    expect(await ensureRootRepo(workspacePaths(work), historyRoot)).toBe(true);
    // The boot sequence converges .claude skills (e.g. the drafts skill) BEFORE committing the baseline.
    await mkdir(join(work, ".claude", "skills", "drafts"), { recursive: true });
    await writeFile(join(work, ".claude", "skills", "drafts", "SKILL.md"), "converged\n");
    await commitRootBaseline(workspacePaths(work));

    expect(await sh(work, "ls-files")).toBe(".claude/skills/drafts/SKILL.md");
    expect(await bothSides(work)).toEqual([]);
});

// A repo dir that reached root's index — the shape the exclude list can no longer act on. `add -f` is how it
// happens for real: a clone staged before the derived exclude list caught up with it, or an agent's own forced
// add, committed by whoever reviewed the workspace next.
const trackNestedRepo = async (work: string, repo: string): Promise<void> => {
    await sh(work, "add", "-f", "-A", "--", repo);
    await sh(work, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "fix: migration");
};
const nestedRepo = async (work: string, repo: string): Promise<string> => {
    const dir = join(work, repo);
    await mkdir(dir, { recursive: true });
    await sh(dir, "init", "-q", "--initial-branch=main");
    await writeFile(join(dir, "app.ts"), "v1\n");
    await sh(dir, "add", "-A");
    await sh(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "one");
    return dir;
};
const commitInNested = async (dir: string): Promise<string> => {
    await writeFile(join(dir, "app.ts"), "v2\n");
    await sh(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-aq", "-m", "two");
    return sh(dir, "rev-parse", "HEAD");
};

test("a nested repo tracked in root's index is untracked and the removal committed", async () => {
    const { work, historyRoot } = await tempBase();
    const nested = await nestedRepo(work, "intent");
    await ensureRootRepo(workspacePaths(work), historyRoot);
    await commitRootBaseline(workspacePaths(work));
    await trackNestedRepo(work, "intent");
    const head = await commitInNested(nested);
    // The bug: excluding a path git already tracks does nothing, so the nested HEAD move surfaces in root.
    expect(await bothSides(work)).toMatchObject([{ path: "intent", status: "modified" }]);

    expect(await ensureRootRepo(workspacePaths(work), historyRoot)).toBe(false);

    // Gone from the index AND from the commit, so no later HEAD move can bring it back.
    expect(await sh(work, "ls-files")).toBe("");
    expect(await sh(work, "ls-tree", "--name-only", "HEAD")).toBe("");
    expect(await bothSides(work)).toEqual([]);
    expect(await sh(work, "log", "--format=%s")).toBe("chore: untrack nested repositories\nfix: migration\nInitialize workspace");
    // The repo itself is untouched — same checkout, same HEAD.
    expect(await sh(nested, "rev-parse", "HEAD")).toBe(head);
    expect(await readFile(join(nested, "app.ts"), "utf8")).toBe("v2\n");
});

test("untracking a nested repo leaves the user's own staged work staged, and out of the commit", async () => {
    const { work, historyRoot } = await tempBase();
    await writeFile(join(work, "notes.md"), "hello\n");
    await nestedRepo(work, "intent");
    await ensureRootRepo(workspacePaths(work), historyRoot);
    await commitRootBaseline(workspacePaths(work));
    await trackNestedRepo(work, "intent");
    await writeFile(join(work, "notes.md"), "staged edit\n");
    await sh(work, "add", "notes.md");

    await ensureRootRepo(workspacePaths(work), historyRoot);

    // Still staged, and the housekeeping commit recorded only the removal.
    expect(await sh(work, "diff", "--cached", "--name-only")).toBe("notes.md");
    expect(await sh(work, "show", "--format=", "--name-status", "HEAD")).toBe("D\tintent");
});

// A conversation's own checkout of root, the shape agents/worktrees.ts creates it in.
const agentWorktree = async (work: string, branch: string): Promise<string> => {
    const dir = join(dirname(work), branch);
    await sh(work, "worktree", "add", "-q", "-b", branch, dir);
    return dir;
};

test("a conversation's root worktree stages a nested repo but never commits one", async () => {
    const { work, historyRoot } = await tempBase();
    await ensureRootRepo(workspacePaths(work), historyRoot);
    await commitRootBaseline(workspacePaths(work));
    const worktree = await agentWorktree(work, "agent-one");
    // A repo the derived exclude list cannot name: the agent cloned it into its own tree, so the main checkout
    // discovery reads has never seen it.
    await nestedRepo(worktree, "intent");
    await writeFile(join(worktree, "notes.md"), "agent work\n");

    expect(await commitWorktreeRemainder("root", worktree, "Agent: one")).toBe(true);

    expect(await sh(worktree, "show", "--format=", "--name-status", "HEAD")).toBe("A\tnotes.md");
    expect(await sh(worktree, "ls-files")).toBe("notes.md");
    // The checkout is untouched — the repo is still there, still its own.
    expect(await readFile(join(worktree, "intent", "app.ts"), "utf8")).toBe("v1\n");
});

test("a nested repo a past turn committed is dropped, and the review's span comes back clean", async () => {
    const { work, historyRoot } = await tempBase();
    await ensureRootRepo(workspacePaths(work), historyRoot);
    await commitRootBaseline(workspacePaths(work));
    const worktree = await agentWorktree(work, "agent-one");
    const nested = await nestedRepo(worktree, "intent");
    // The bug as the branch already carries it: a one-line `+1` add for the repo, back on every land as the
    // repo's own HEAD moves.
    await trackNestedRepo(worktree, "intent");
    await commitInNested(nested);
    expect(await sh(worktree, "diff", "--name-only", "main")).toBe("intent");

    await writeFile(join(worktree, "notes.md"), "agent work\n");
    expect(await commitWorktreeRemainder("root", worktree, "Agent: one")).toBe(true);

    // Added and removed inside this branch, so anchor→tip — what the agent's review reads — has no row for it.
    expect(await sh(worktree, "diff", "--name-only", "main")).toBe("notes.md");
    expect(await sh(worktree, "show", "--format=", "--name-status", "HEAD")).toBe("D\tintent\nA\tnotes.md");
});

test("a NESTED repo of the composition keeps a gitlink of its own — that one is the user's submodule", async () => {
    const { work, historyRoot } = await tempBase();
    await ensureRootRepo(workspacePaths(work), historyRoot);
    const app = await nestedRepo(work, "app");
    await nestedRepo(app, "vendor");

    expect(await commitWorktreeRemainder("app", app, "Agent: one")).toBe(true);

    expect(await sh(app, "ls-files")).toBe("app.ts\nvendor");
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
