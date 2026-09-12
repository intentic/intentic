import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { STATE_DIR } from "@intentic/constants";
import { defaultGit } from "@intentic/scaffold";
import { afterEach, expect, test } from "vitest";
import { isolatedAgent, noIsolation } from "../../testing.js";
import { changesAgainstBase } from "../../git/changes/changes.js";
import { ensureRootRepo } from "../../git/remote/root-repo.js";
import { createLogger } from "../../logger.js";
import { createPerfTracker } from "../../platform/resources/perf.js";
import { workspacePaths } from "../../workspace/workspace.js";
import { anchorOf } from "./agent-changes.js";

import { landAgent, outstandingConflicts, pruneEmptiedDirs } from "./land.js";
import { createAgentWorktrees, type AgentWorktrees, type ConversationWorktree } from "../worktrees/worktrees.js";

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });
const perf = createPerfTracker(logger);

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
    await writeFile(join(work, "app.ts"), "line one\nline two\nline three\n");
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "baseline");
    const worktrees = createAgentWorktrees({
        workspace,
        worktreesRoot: join(historyRoot, "worktrees"),
        historyRoot,
        isolation: noIsolation(work, historyRoot),
        logger,
        perf,
    });
    const conversation = await worktrees.ensure("c1", []);
    return { work, worktrees, conversation };
};

test("land applies the delta as UNCOMMITTED main-tree changes: HEAD never moves", async () => {
    const { work, worktrees, conversation } = await setup();
    const head = await sh(work, "rev-parse", "HEAD");
    await writeFile(join(conversation.cwd, "app.ts"), "line one EDITED\nline two\nline three\n");
    await writeFile(join(conversation.cwd, "added.ts"), "new file\n");

    const result = await landAgent(worktrees, isolatedAgent(conversation.repos));
    expect(result.landed).toBe(true);
    expect(result.changed).toBe(true);
    expect(await readFile(join(work, "app.ts"), "utf8")).toBe("line one EDITED\nline two\nline three\n");
    expect(await readFile(join(work, "added.ts"), "utf8")).toBe("new file\n");
    expect(await sh(work, "rev-parse", "HEAD")).toBe(head);
    expect(await sh(work, "status", "--porcelain")).not.toBe("");
    const root = result.repos.find((repo) => repo.repo === "root");
    expect(root?.landedTip).toBe(await sh(conversation.cwd, "rev-parse", "HEAD"));
});

// Config edits in `.intentic/config` (checked out in the worktree) take the same road as any file: committed on the
// branch, patched into Changes with an author, never written straight to the live tree.
test("an agent's edit to a versioned state file lands as an uncommitted main-tree change", async () => {
    const { work, worktrees, conversation } = await setup();
    await mkdir(join(conversation.cwd, STATE_DIR, "config"), { recursive: true });
    await writeFile(join(conversation.cwd, STATE_DIR, "config", "settings.json"), '{"model":"agent"}\n');
    expect(existsSync(join(work, STATE_DIR, "config", "settings.json"))).toBe(false);

    const result = await landAgent(worktrees, isolatedAgent(conversation.repos));
    expect(result.landed).toBe(true);
    expect(result.changed).toBe(true);
    expect(await readFile(join(work, STATE_DIR, "config", "settings.json"), "utf8")).toBe('{"model":"agent"}\n');
    // The derived exclude carves the versioned entry back in, so it shows as a real untracked row, not an ignored one.
    expect(await sh(work, "status", "--porcelain", "-uall")).toContain(`?? ${STATE_DIR}/config/settings.json`);
    expect(await sh(conversation.cwd, "show", "--stat", "--format=", "HEAD")).toContain(`${STATE_DIR}/config/settings.json`);
});

test("nothing to land reads as changed:false (no frame, no status flip)", async () => {
    const { worktrees, conversation } = await setup();
    const result = await landAgent(worktrees, isolatedAgent(conversation.repos));
    expect(result).toMatchObject({ landed: true, changed: false });
    expect(result.diff).toEqual({ files: 0, insertions: 0, deletions: 0 });
});

test("land reports the agent's cumulative diffstat (files, +insertions, −deletions)", async () => {
    const { worktrees, conversation } = await setup();
    // app.ts: one line replaced (1 insertion, 1 deletion); added.ts: 2 new lines.
    await writeFile(join(conversation.cwd, "app.ts"), "line one EDITED\nline two\nline three\n");
    await writeFile(join(conversation.cwd, "added.ts"), "new file\nsecond line\n");

    const first = await landAgent(worktrees, isolatedAgent(conversation.repos));
    expect(first.diff).toEqual({ files: 2, insertions: 3, deletions: 1 });

    // Cumulative, not per-land: the second turn's edit re-reports the whole base->tip output.
    await writeFile(join(conversation.cwd, "added.ts"), "new file\nsecond line\nthird line\n");
    const second = await landAgent(worktrees, isolatedAgent(first.repos));
    expect(second.diff).toEqual({ files: 2, insertions: 4, deletions: 1 });
});

test("incremental: a re-touched file lands its second delta onto the previously-landed copy", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), "line one EDITED\nline two\nline three\n");
    const first = await landAgent(worktrees, isolatedAgent(conversation.repos));
    expect(first.landed).toBe(true);

    // Main still holds the landed copy, so context matches; a path-overlap check would false-flag this.
    await writeFile(join(conversation.cwd, "app.ts"), "line one EDITED\nline two\nline three EDITED TOO\n");
    const second = await landAgent(worktrees, isolatedAgent(first.repos));
    expect(second.landed).toBe(true);
    expect(await readFile(join(work, "app.ts"), "utf8")).toBe("line one EDITED\nline two\nline three EDITED TOO\n");
});

test("a user edit on the same lines conflicts: nothing applies, main is untouched, the path is named", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), "line one AGENT\nline two\nline three\n");
    await writeFile(join(work, "app.ts"), "line one USER\nline two\nline three\n");

    const result = await landAgent(worktrees, isolatedAgent(conversation.repos));
    expect(result.landed).toBe(false);
    expect(result.changed).toBe(true);
    expect(result.conflicts).toEqual([{ repo: "root", paths: [{ path: "app.ts", reason: "workspace" }], clean: 0, mainBranch: "main" }]);
    expect(await readFile(join(work, "app.ts"), "utf8")).toBe("line one USER\nline two\nline three\n");
    expect(await readFile(join(conversation.cwd, "app.ts"), "utf8")).toBe("line one AGENT\nline two\nline three\n");
});

test("names only the paths that actually refuse, and counts what would land anyway", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), "line one AGENT\nline two\nline three\n");
    await writeFile(join(conversation.cwd, "added.ts"), "brand new\n");
    await writeFile(join(work, "app.ts"), "line one USER\nline two\nline three\n");

    const result = await landAgent(worktrees, isolatedAgent(conversation.repos));

    // `git apply` is atomic, so both files are held back; only one is the actual reason.
    expect(result.conflicts).toEqual([{ repo: "root", paths: [{ path: "app.ts", reason: "workspace" }], clean: 1, mainBranch: "main" }]);
    expect(existsSync(join(work, "added.ts"))).toBe(false);
});

// The stored report is a land-time snapshot; its `workspace` reason rots once the user commits, which no land observes.
test("a workspace refusal re-derives as diverged once the user commits their edit", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), "line one AGENT\nline two\nline three\n");
    await writeFile(join(work, "app.ts"), "line one USER\nline two\nline three\n");
    const entry = isolatedAgent(conversation.repos);
    const refusal = await landAgent(worktrees, entry);
    expect(refusal.conflicts).toEqual([{ repo: "root", paths: [{ path: "app.ts", reason: "workspace" }], clean: 0, mainBranch: "main" }]);

    expect(await outstandingConflicts(worktrees, entry)).toEqual(refusal.conflicts);

    // No land runs, so the stored report still says `workspace`; re-derivation calls it `diverged` instead.
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "user commits their half");
    expect(await outstandingConflicts(worktrees, entry)).toEqual([
        { repo: "root", paths: [{ path: "app.ts", reason: "diverged" }], clean: 0, mainBranch: "main" },
    ]);
});

test("a refusal whose cause has evaporated re-derives to no conflicts at all", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), "line one AGENT\nline two\nline three\n");
    await writeFile(join(work, "app.ts"), "line one USER\nline two\nline three\n");
    const entry = isolatedAgent(conversation.repos);
    expect((await landAgent(worktrees, entry)).landed).toBe(false);

    await writeFile(join(work, "app.ts"), "line one\nline two\nline three\n");
    expect(await outstandingConflicts(worktrees, entry)).toEqual([]);
});

test("blames the moved main line, not the workspace, when the conflict is a committed divergence", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), "line one AGENT\nline two\nline three\n");
    // Main moved and committed; the workspace is clean, unlike the workspace-conflict tests above.
    await writeFile(join(work, "app.ts"), "line one MAIN\nline two\nline three\n");
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "main moved");

    const result = await landAgent(worktrees, isolatedAgent(conversation.repos));

    expect(result.conflicts).toEqual([{ repo: "root", paths: [{ path: "app.ts", reason: "diverged" }], clean: 0, mainBranch: "main" }]);
});

test("re-anchors on the merge-base, so an agent rebased onto the moved main line still lands its own work", async () => {
    const { work, worktrees, conversation } = await setup();
    const recorded = isolatedAgent(conversation.repos);
    await writeFile(join(conversation.cwd, "agent.ts"), "agent work\n");
    await sh(conversation.cwd, "add", "-A");
    await sh(conversation.cwd, "-c", "user.name=a", "-c", "user.email=a@a", "commit", "-q", "-m", "agent");

    await writeFile(join(work, "main-only.ts"), "main work\n");
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "main moved");
    // Rebasing pulls main's commit onto the branch; a delta from the frozen base would replay it and fail wholesale.
    await sh(conversation.cwd, "-c", "user.name=a", "-c", "user.email=a@a", "rebase", await sh(work, "rev-parse", "HEAD"));

    const result = await landAgent(worktrees, recorded);

    expect(result.conflicts).toBeUndefined();
    expect(result.landed).toBe(true);
    expect(await readFile(join(work, "agent.ts"), "utf8")).toBe("agent work\n");
    expect(await readFile(join(work, "main-only.ts"), "utf8")).toBe("main work\n");
});

// The dead end this rules out: content that reached main as a different commit looks unmerged to the merge-base anchor,
// so every path would refuse to apply. The reverse probe recognizes it as already there instead.
test("work the agent committed onto the main line itself lands as a no-op instead of conflicting", async () => {
    const { work, worktrees, conversation } = await setup();
    const recorded = isolatedAgent(conversation.repos);
    await writeFile(join(conversation.cwd, "agent.ts"), "agent work\n");
    await writeFile(join(conversation.cwd, "app.ts"), "line one AGENT\nline two\nline three\n");
    await sh(conversation.cwd, "add", "-A");
    await sh(conversation.cwd, "-c", "user.name=a", "-c", "user.email=a@a", "commit", "-q", "-m", "agent");
    // Same content, unrelated sha: identical tree, but arrived as its own commit rather than the agent's.
    await writeFile(join(work, "agent.ts"), "agent work\n");
    await writeFile(join(work, "app.ts"), "line one AGENT\nline two\nline three\n");
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "the same work, by hand");

    const result = await landAgent(worktrees, recorded);

    expect(result.conflicts).toBeUndefined();
    expect(result.landed).toBe(true);
    expect(await sh(work, "status", "--porcelain")).toBe("");
    // Tip advances regardless, or every later land re-offers this same delta forever.
    expect(result.repos[0]?.landedTip).toBe(await sh(conversation.cwd, "rev-parse", "HEAD"));
});

// The other road: the branch itself gets merged into main. Ancestry says everything is merged, so land applies nothing,
// but must still advance landedTip, or the review counts every file as unlanded forever.
test("work that reached main by merging the branch advances landedTip as a real outcome", async () => {
    const { work, worktrees, conversation } = await setup();
    const recorded = isolatedAgent(conversation.repos);
    await writeFile(join(conversation.cwd, "agent.ts"), "agent work\n");
    await sh(conversation.cwd, "add", "-A");
    await sh(conversation.cwd, "-c", "user.name=a", "-c", "user.email=a@a", "commit", "-q", "-m", "agent");
    const tip = await sh(conversation.cwd, "rev-parse", "HEAD");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "merge", "-q", "--no-ff", "-m", "land it", tip);

    const result = await landAgent(worktrees, recorded);

    expect(result.conflicts).toBeUndefined();
    expect(result.landed).toBe(true);
    // changed:true is a real outcome: it tells the caller to persist the tip and clear any old conflicts.
    expect(result.changed).toBe(true);
    expect(result.repos[0]?.landedTip).toBe(tip);
    expect(await sh(work, "status", "--porcelain")).toBe("");

    const again = await landAgent(worktrees, isolatedAgent(result.repos));
    expect(again.changed).toBe(false);
});

test("a delta half-landed by hand lands its remainder, and reports no conflict for the half already there", async () => {
    const { work, worktrees, conversation } = await setup();
    const recorded = isolatedAgent(conversation.repos);
    await writeFile(join(conversation.cwd, "already.ts"), "already on main\n");
    await writeFile(join(conversation.cwd, "outstanding.ts"), "still to land\n");
    await sh(conversation.cwd, "add", "-A");
    await sh(conversation.cwd, "-c", "user.name=a", "-c", "user.email=a@a", "commit", "-q", "-m", "agent");
    // Only `already.ts` is carried to main by hand; `outstanding.ts` is not, so it's the one land still owes.
    await writeFile(join(work, "already.ts"), "already on main\n");
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "half of it, by hand");

    const result = await landAgent(worktrees, recorded);

    expect(result.conflicts).toBeUndefined();
    expect(result.landed).toBe(true);
    expect(await readFile(join(work, "outstanding.ts"), "utf8")).toBe("still to land\n");
});

test("merge mode lands every clean path and leaves the diverged one with conflict markers to finish", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), "line one AGENT\nline two\nline three\n");
    await writeFile(join(conversation.cwd, "added.ts"), "brand new\n");
    // Main moved and committed, so the workspace is clean, which is what lets a three-way merge run at all.
    await writeFile(join(work, "app.ts"), "line one MAIN\nline two\nline three\n");
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "main moved");

    const result = await landAgent(worktrees, isolatedAgent(conversation.repos), "merge");

    expect(await readFile(join(work, "added.ts"), "utf8")).toBe("brand new\n");
    const merged = await readFile(join(work, "app.ts"), "utf8");
    expect(merged).toContain("<<<<<<<");
    expect(merged).toContain("line one AGENT");
    expect(merged).toContain("line one MAIN");
    expect(result.resolving).toEqual([{ repo: "root", paths: ["app.ts"] }]);
});

test("merge mode declines when the clash is with uncommitted work, because git cannot merge through it", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), "line one AGENT\nline two\nline three\n");
    await writeFile(join(work, "app.ts"), "line one USER\nline two\nline three\n");

    const result = await landAgent(worktrees, isolatedAgent(conversation.repos), "merge");

    // `--3way` goes through the index and refuses outright on an unstaged path, applying nothing at all.
    expect(result.resolving).toBeUndefined();
    expect(result.conflicts).toEqual([{ repo: "root", paths: [{ path: "app.ts", reason: "workspace" }], clean: 0, mainBranch: "main" }]);
    expect(await readFile(join(work, "app.ts"), "utf8")).toBe("line one USER\nline two\nline three\n");
});

test("a user edit ELSEWHERE in the same file still lands (patch context, not path sets)", async () => {
    const { work, worktrees } = await setup();
    // Twelve lines keep the two hunks' +/-3 context from overlapping; a 3-line file would turn any same-file edit into
    // the collision this isn't testing.
    const lines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
    const body = (edits: Record<number, string>): string => `${lines.map((line, index) => edits[index + 1] ?? line).join("\n")}\n`;
    await writeFile(join(work, "app.ts"), body({}));
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "long file");
    const grown = await worktrees.ensure("c2", []);
    await writeFile(join(grown.cwd, "app.ts"), body({ 1: "line 1 AGENT" }));
    await writeFile(join(work, "app.ts"), body({ 12: "line 12 USER" }));

    const result = await landAgent(worktrees, { ...isolatedAgent(grown.repos), id: "c2", branch: "agent/c2" });
    expect(result.landed).toBe(true);
    expect(await readFile(join(work, "app.ts"), "utf8")).toBe(body({ 1: "line 1 AGENT", 12: "line 12 USER" }));
});

test("a delta living only in a NESTED repo lands: root has nothing it can stage, and says so quietly", async () => {
    const { work, worktrees } = await setup();
    // A gitlink can't be staged directly (it moves only when the nested repo's own HEAD does), so root always excludes
    // the nested repo from its own commit (git/root-repo.ts).
    const inner = join(work, "inner");
    await mkdir(inner, { recursive: true });
    await writeFile(join(inner, "lib.ts"), "inner one\ninner two\n");
    await sh(inner, "init", "-q", "--initial-branch=main");
    await sh(inner, "add", "-A");
    await sh(inner, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "inner baseline");

    const conversation = await worktrees.ensure("c2", []);
    expect(conversation.repos.map(({ repo }) => repo)).toEqual(["root", "inner"]);
    await writeFile(join(worktrees.worktreeDir("c2", "inner"), "lib.ts"), "inner one EDITED\ninner two\n");

    const result = await landAgent(worktrees, { ...isolatedAgent(conversation.repos), id: "c2", branch: "agent/c2" });
    expect(result.landed).toBe(true);
    expect(result.conflicts).toBeUndefined();
    expect(await readFile(join(inner, "lib.ts"), "utf8")).toBe("inner one EDITED\ninner two\n");
    expect(result.repos.find((repo) => repo.repo === "root")?.landedTip).toBeUndefined();
    expect(result.repos.find((repo) => repo.repo === "inner")?.landedTip).toBe(await sh(worktrees.worktreeDir("c2", "inner"), "rev-parse", "HEAD"));
});

test("a conflict in one repository refuses the whole composition without advancing any landed tip", async () => {
    const { work, worktrees } = await setup();
    const inner = join(work, "inner");
    await mkdir(inner, { recursive: true });
    await writeFile(join(inner, "lib.ts"), "inner one\ninner two\n");
    await sh(inner, "init", "-q", "--initial-branch=main");
    await sh(inner, "add", "-A");
    await sh(inner, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "inner baseline");

    const conversation = await worktrees.ensure("c2", []);
    const rootWorktree = worktrees.worktreeDir("c2", "root");
    const innerWorktree = worktrees.worktreeDir("c2", "inner");
    await writeFile(join(rootWorktree, "app.ts"), "line one AGENT\nline two\nline three\n");
    await writeFile(join(innerWorktree, "lib.ts"), "inner one AGENT\ninner two\n");
    await writeFile(join(inner, "lib.ts"), "inner one USER\ninner two\n");

    const result = await landAgent(worktrees, { ...isolatedAgent(conversation.repos), id: "c2", branch: "agent/c2" });

    expect(result.landed).toBe(false);
    expect(result.conflicts).toEqual([{ repo: "inner", paths: [{ path: "lib.ts", reason: "workspace" }], clean: 0, mainBranch: "main" }]);
    // Root's own patch passed, but the land is one transaction: the nested refusal keeps both trees untouched.
    expect(await readFile(join(work, "app.ts"), "utf8")).toBe("line one\nline two\nline three\n");
    expect(await readFile(join(inner, "lib.ts"), "utf8")).toBe("inner one USER\ninner two\n");
    expect(result.repos.map(({ repo, landedTip }) => ({ repo, landedTip }))).toEqual([
        { repo: "root", landedTip: undefined },
        { repo: "inner", landedTip: undefined },
    ]);

    await writeFile(join(inner, "lib.ts"), "inner one\ninner two\n");
    const recovered = await landAgent(worktrees, {
        ...isolatedAgent(result.repos),
        id: "c2",
        branch: "agent/c2",
    });
    expect(recovered.landed).toBe(true);
    expect(await readFile(join(work, "app.ts"), "utf8")).toBe("line one AGENT\nline two\nline three\n");
    expect(await readFile(join(inner, "lib.ts"), "utf8")).toBe("inner one AGENT\ninner two\n");
    expect(recovered.repos.map(({ repo, landedTip }) => ({ repo, landedTip }))).toEqual([
        { repo: "root", landedTip: await sh(rootWorktree, "rev-parse", "HEAD") },
        { repo: "inner", landedTip: await sh(innerWorktree, "rev-parse", "HEAD") },
    ]);
});

// A retired checkout still holds the branch's full work via the shared object store (retire commits the worktree's
// remainder onto agent/<id>), so it is not 'nothing to land'.
test("a retired checkout still lands: the branch answers for the missing worktree", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), "line one EDITED\nline two\nline three\n");
    await writeFile(join(conversation.cwd, "added.ts"), "new file\n");
    await worktrees.retire("c1", conversation.repos, "fix the thing");
    expect(existsSync(worktrees.worktreeDir("c1", "root"))).toBe(false);

    const result = await landAgent(worktrees, isolatedAgent(conversation.repos));

    expect(result.landed).toBe(true);
    expect(result.changed).toBe(true);
    expect(await readFile(join(work, "app.ts"), "utf8")).toBe("line one EDITED\nline two\nline three\n");
    expect(await readFile(join(work, "added.ts"), "utf8")).toBe("new file\n");
    // The cumulative diffstat still reports: the card's numbers survive a retired checkout.
    expect(result.diff.files).toBe(2);
    // landedTip reached the branch tip, so the review stops counting these files as pending.
    expect(result.repos.find((repo) => repo.repo === "root")?.landedTip).toBe(await sh(work, "rev-parse", "agent/c1"));
});

test("a retired checkout with everything landed is a no-op that still reports the cumulative output", async () => {
    const { worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), "line one EDITED\nline two\nline three\n");
    const first = await landAgent(worktrees, isolatedAgent(conversation.repos));
    await worktrees.retire("c1", conversation.repos, "fix the thing");

    const again = await landAgent(worktrees, isolatedAgent(first.repos));

    // changed:false hides the frame; diff.files>0 is what keeps the caller's status at `landed`, not idle.
    expect(again).toMatchObject({ landed: true, changed: false });
    expect(again.diff.files).toBe(1);
});

test("a discard fired during an in-flight land queues behind the repo lock: land finishes first", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), "line one AGENT\nline two\nline three\n");

    // notRunning only tracks streaming turns; the per-repo lock alone keeps a discard out of a half-applied land.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    let paused: (() => void) | undefined;
    const pausedAt = new Promise<void>((resolve) => {
        paused = resolve;
    });
    const pausingGit: typeof defaultGit = async (dir, args) => {
        if (args[0] === "apply" && args[1] === "--check") {
            paused?.();
            await gate;
        }
        return defaultGit(dir, args);
    };

    const landing = landAgent(worktrees, isolatedAgent(conversation.repos), "check", "outstanding", pausingGit);
    await pausedAt;
    let removed = false;
    const removing = worktrees.remove("c1", conversation.repos).then(() => {
        removed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(removed).toBe(false);

    release();
    const result = await landing;
    await removing;
    expect(result.landed).toBe(true);
    expect(await readFile(join(work, "app.ts"), "utf8")).toBe("line one AGENT\nline two\nline three\n");
    expect(existsSync(worktrees.worktreeDir("c1", "root"))).toBe(false);
});

test("a fully reverted delta lands as a no-op: landedTip advances, no phantom conflict", async () => {
    const { work, worktrees, conversation } = await setup();
    // Patch is empty though tip != base; `git apply` rejects empty patches, so the net-zero branch advances the tip.
    await writeFile(join(conversation.cwd, "app.ts"), "line one EDITED\nline two\nline three\n");
    await sh(conversation.cwd, "add", "-A");
    await sh(conversation.cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "edit");
    await writeFile(join(conversation.cwd, "app.ts"), "line one\nline two\nline three\n");

    const result = await landAgent(worktrees, isolatedAgent(conversation.repos));
    expect(result.landed).toBe(true);
    expect(result.conflicts).toBeUndefined();
    expect(await sh(work, "status", "--porcelain")).toBe("");
    expect(result.repos.find((repo) => repo.repo === "root")?.landedTip).toBe(await sh(conversation.cwd, "rev-parse", "HEAD"));
    const again = await landAgent(worktrees, isolatedAgent(result.repos));
    expect(again).toMatchObject({ landed: true, changed: false });
});

// Auto-land off: every land step runs except touching the main tree; the outstanding delta is reported `held` instead
// of applied, for the caller to stamp `Ready to land`.
test("measure holds the delta on the branch: nothing applies, tips stay, the diffstat still reports", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), "line one EDITED\nline two\nline three\n");
    await writeFile(join(conversation.cwd, "added.ts"), "new file\n");

    const result = await landAgent(worktrees, isolatedAgent(conversation.repos), "measure");

    // A real outcome (the caller persists and flips status), but neither landed nor refused.
    expect(result).toMatchObject({ landed: false, changed: true, held: true });
    expect(result.conflicts).toBeUndefined();
    expect(await readFile(join(work, "app.ts"), "utf8")).toBe("line one\nline two\nline three\n");
    expect(existsSync(join(work, "added.ts"))).toBe(false);
    expect(await sh(work, "status", "--porcelain")).toBe("");
    expect(result.diff).toEqual({ files: 2, insertions: 2, deletions: 1 });
    // landedTip stays unset: the eventual deliberate land still carries this exact delta.
    expect(result.repos.find((repo) => repo.repo === "root")?.landedTip).toBeUndefined();
    // The provenance commit still happened: the worktree's dirty state is safe on agent/c1.
    expect(await sh(conversation.cwd, "status", "--porcelain")).toBe("");

    const landed = await landAgent(worktrees, isolatedAgent(result.repos));
    expect(landed.landed).toBe(true);
    expect(landed.held).toBeUndefined();
    expect(await readFile(join(work, "app.ts"), "utf8")).toBe("line one EDITED\nline two\nline three\n");
    expect(await readFile(join(work, "added.ts"), "utf8")).toBe("new file\n");
});

test("measure still recognizes work that reached main by another road, instead of holding it forever", async () => {
    const { work, worktrees, conversation } = await setup();
    const recorded = isolatedAgent(conversation.repos);
    await writeFile(join(conversation.cwd, "agent.ts"), "agent work\n");
    await sh(conversation.cwd, "add", "-A");
    await sh(conversation.cwd, "-c", "user.name=a", "-c", "user.email=a@a", "commit", "-q", "-m", "agent");
    // Same content reaches main as its own commit; a held card offering to land it could never do anything.
    await writeFile(join(work, "agent.ts"), "agent work\n");
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "the same work, by hand");

    const result = await landAgent(worktrees, isolatedAgent(recorded.repos), "measure");

    expect(result.held).toBeUndefined();
    expect(result).toMatchObject({ landed: true, changed: true });
    expect(result.repos[0]?.landedTip).toBe(await sh(conversation.cwd, "rev-parse", "HEAD"));
    expect(await sh(work, "status", "--porcelain")).toBe("");
});

test("measure with nothing to measure stays changed:false, like any other no-op land", async () => {
    const { worktrees, conversation } = await setup();
    const result = await landAgent(worktrees, isolatedAgent(conversation.repos), "measure");
    expect(result).toMatchObject({ landed: true, changed: false });
    expect(result.held).toBeUndefined();
});

// With auto-land held, every turn ends in `measure`, and a `measure` with no verdict can never retire a conflict the
// agent already fixed.

test("measure re-judges a stored refusal, so a resolved conflict stops outliving its cause", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), "line one AGENT\nline two\nline three\n");
    await writeFile(join(work, "app.ts"), "line one USER\nline two\nline three\n");
    const refused = await landAgent(worktrees, isolatedAgent(conversation.repos));
    expect(refused.conflicts).toHaveLength(1);

    // The cause goes away, as a resolve turn does; this is the only pass that runs at the end of it.
    await writeFile(join(work, "app.ts"), "line one\nline two\nline three\n");
    const settled = await landAgent(worktrees, isolatedAgent(conversation.repos, { conflicts: refused.conflicts }), "measure");

    // A verdict lets `recordLanded` replace the stored one; an empty verdict is what clears it.
    expect(settled.adjudicated).toBe(true);
    expect(settled.conflicts).toBeUndefined();
    // Still held: re-judging reports what the tree now makes of the delta, it does not land it.
    expect(settled).toMatchObject({ landed: false, held: true });
    expect(await sh(work, "status", "--porcelain")).toBe("");
});

test("a re-judged refusal that still stands is reported again, not quietly retired", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), "line one AGENT\nline two\nline three\n");
    await writeFile(join(work, "app.ts"), "line one USER\nline two\nline three\n");
    const refused = await landAgent(worktrees, isolatedAgent(conversation.repos));

    const settled = await landAgent(worktrees, isolatedAgent(conversation.repos, { conflicts: refused.conflicts }), "measure");

    expect(settled.adjudicated).toBe(true);
    expect(settled.conflicts).toEqual([{ repo: "root", paths: [{ path: "app.ts", reason: "workspace" }], clean: 0, mainBranch: "main" }]);
    // A conflict is the louder fact, reported exactly as a real land would report it for this tree.
    expect(settled.held).toBeUndefined();
    // Measure's promise holds either way: the gate is `apply --check`, which writes nothing.
    expect(await readFile(join(work, "app.ts"), "utf8")).toBe("line one USER\nline two\nline three\n");
    // `sh` trims output, so the porcelain status's leading column arrives without its usual leading space.
    expect(await sh(work, "status", "--porcelain")).toBe("M app.ts");
});

test("an agent nothing refuses is not re-judged, so an ordinary measure still offers no verdict", async () => {
    const { worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), "line one EDITED\nline two\nline three\n");

    const result = await landAgent(worktrees, isolatedAgent(conversation.repos), "measure");

    // An agent nothing refuses reaches no gate, so it gets no verdict and can't retire a later one.
    expect(result.adjudicated).toBe(false);
    expect(result).toMatchObject({ landed: false, held: true });
    expect(result.conflicts).toBeUndefined();
});

test("deletes and renames land; a conflicted land keeps landedTip so recovery applies the same delta", async () => {
    const { work, worktrees, conversation } = await setup();
    await sh(conversation.cwd, "mv", "app.ts", "renamed.ts");
    await sh(conversation.cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "rename");

    const result = await landAgent(worktrees, isolatedAgent(conversation.repos));
    expect(result.landed).toBe(true);
    expect(existsSync(join(work, "app.ts"))).toBe(false);
    expect(await readFile(join(work, "renamed.ts"), "utf8")).toBe("line one\nline two\nline three\n");

    // Agent edits renamed.ts; the user edits the main copy on the same line, to force a real collision.
    await writeFile(join(conversation.cwd, "renamed.ts"), "line one AGENT\nline two\nline three\n");
    await writeFile(join(work, "renamed.ts"), "line one USER\nline two\nline three\n");
    const conflicted = await landAgent(worktrees, isolatedAgent(result.repos));
    expect(conflicted.landed).toBe(false);
    expect(conflicted.repos.find((repo) => repo.repo === "root")?.landedTip).toBe(result.repos.find((repo) => repo.repo === "root")?.landedTip);
    await writeFile(join(work, "renamed.ts"), "line one\nline two\nline three\n");
    const recovered = await landAgent(worktrees, isolatedAgent(conflicted.repos));
    expect(recovered.landed).toBe(true);
    expect(await readFile(join(work, "renamed.ts"), "utf8")).toBe("line one AGENT\nline two\nline three\n");
});

// Subset lands used `--name-only`, which names a rename only at its destination, so the pathspec couldn't express it:
// `-M` fell back to a bare creation and left the old path in the tree (land.ts DeltaChange).
test("a rename landing as part of a half-landed delta leaves no stale source behind", async () => {
    const { work, worktrees, conversation } = await setup();
    const recorded = isolatedAgent(conversation.repos);
    await sh(conversation.cwd, "mv", "app.ts", "moved.ts");
    await writeFile(join(conversation.cwd, "already.ts"), "already on main\n");
    await sh(conversation.cwd, "add", "-A");
    await sh(conversation.cwd, "-c", "user.name=a", "-c", "user.email=a@a", "commit", "-q", "-m", "rename plus a file");
    // Half the delta is already on main, so the atomic apply falls back to the outstanding remainder: the rename.
    await writeFile(join(work, "already.ts"), "already on main\n");
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "half of it, by hand");

    const result = await landAgent(worktrees, recorded);

    expect(result.conflicts).toBeUndefined();
    expect(result.landed).toBe(true);
    expect(await readFile(join(work, "moved.ts"), "utf8")).toBe("line one\nline two\nline three\n");
    // The delete leg: the assertion this bug used to fail.
    expect(existsSync(join(work, "app.ts"))).toBe(false);
});

// Same subset-land defect, the other pathological change: a deletion's whole content is the removal itself, which a
// pathspec-built patch can also decline to express.
test("a deletion landing as part of a half-landed delta removes the file", async () => {
    const { work, worktrees } = await setup();
    await writeFile(join(work, "doomed.ts"), "delete me\n");
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "a file to delete");
    // A checkout taken after that commit, so the branch actually has the file to delete; setup()'s own predates it.
    const conversation = await worktrees.ensure("c2", []);
    const recorded = { ...isolatedAgent(conversation.repos), id: "c2", branch: "agent/c2" };
    await rm(join(conversation.cwd, "doomed.ts"));
    await writeFile(join(conversation.cwd, "already.ts"), "already on main\n");
    await sh(conversation.cwd, "add", "-A");
    await sh(conversation.cwd, "-c", "user.name=a", "-c", "user.email=a@a", "commit", "-q", "-m", "delete plus a file");
    await writeFile(join(work, "already.ts"), "already on main\n");
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "half of it, by hand");

    const result = await landAgent(worktrees, recorded);

    expect(result.conflicts).toBeUndefined();
    expect(result.landed).toBe(true);
    expect(existsSync(join(work, "doomed.ts"))).toBe(false);
});

// A rename-with-edits probed at its destination alone looks like a bare creation, which applies against anything, so a
// conflicting edit to the source was invisible. A 100%-similarity rename carries no hunks, so it's never a conflict.
test("a user edit under a rename-with-edits is a conflict, not a clean change", async () => {
    const { work, worktrees, conversation } = await setup();
    await sh(conversation.cwd, "mv", "app.ts", "moved.ts");
    await writeFile(join(conversation.cwd, "moved.ts"), "line one AGENT\nline two\nline three\n");
    await sh(conversation.cwd, "add", "-A");
    await sh(conversation.cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "rename and edit");
    await writeFile(join(work, "app.ts"), "line one USER\nline two\nline three\n");

    const result = await landAgent(worktrees, isolatedAgent(conversation.repos));

    expect(result.landed).toBe(false);
    // Reported at the destination, the path the user will actually go looking for.
    expect(result.conflicts).toEqual([{ repo: "root", paths: [{ path: "moved.ts", reason: "workspace" }], clean: 0, mainBranch: "main" }]);
    // `check` promises a refusal changes nothing, even mid-rename: no half-rename is ever written.
    expect(await readFile(join(work, "app.ts"), "utf8")).toBe("line one USER\nline two\nline three\n");
    expect(existsSync(join(work, "moved.ts"))).toBe(false);
});

// Anchored the way the diff route now anchors it (agent-changes.ts -> anchorOf, no landedTip rung): a worktree
// fast-forwarded onto newer main must not review main's own commits as this agent's.
test("a worktree synced onto newer main commits does not review main's work as its own", async () => {
    const { work, conversation } = await setup();
    const base = conversation.repos.find((repo) => repo.repo === "root")?.base ?? "";
    await writeFile(join(work, "foreign.ts"), "someone else's work\n");
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "foreign");
    // The agent fast-forwards its branch onto the moved main line (the turn-start sync), then works.
    await sh(conversation.cwd, "merge", "--ff-only", await sh(work, "rev-parse", "HEAD"));
    await writeFile(join(conversation.cwd, "own.ts"), "this agent's work\n");

    const anchor = await anchorOf(conversation.cwd, work, "agent/c1", undefined, base);
    expect((await changesAgainstBase(conversation.cwd, anchor)).map((change) => change.path)).toEqual(["own.ts"]);
    // The frozen creation-time base still counts foreign.ts as this agent's, which is the reading anchorOf replaces.
    expect((await changesAgainstBase(conversation.cwd, base)).map((change) => change.path)).toContain("foreign.ts");
});

// The card's counter now reads from the same anchor the review uses (agent-changes.ts), not an independent frozen-base
// shortstat that counted synced-in main commits as the agent's own.
test("the card's diffstat counts the agent's own work, not the main line it synced onto", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(work, "foreign.ts"), "someone else's work\nand a second line\n");
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "foreign");
    await sh(conversation.cwd, "merge", "--ff-only", await sh(work, "rev-parse", "HEAD"));
    await writeFile(join(conversation.cwd, "own.ts"), "this agent's work\n");

    const result = await landAgent(worktrees, isolatedAgent(conversation.repos));

    expect(result.diff).toEqual({ files: 1, insertions: 1, deletions: 0 });
});

// A landedTip-spanned patch can carry pre-images main has since moved past, reporting a conflict the merge already
// reconciled; the merge-base must supersede a stale landedTip.
test("after merging main into the branch, land measures from the merge-base, not the stale landedTip", async () => {
    const { work, worktrees, conversation } = await setup();
    const lines = (...replaced: [number, string][]): string =>
        `${["one", "two", "three", "four", "five", "six", "seven"].map((word, at) => replaced.find(([i]) => i === at)?.[1] ?? word).join("\n")}\n`;
    await writeFile(join(work, "long.ts"), lines());
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "long file");
    await worktrees.remove("c1", conversation.repos);
    const fresh = await worktrees.ensure("c1", []);

    // Turn 1: edit the top, land, then the user commits the landed content on main.
    await writeFile(join(fresh.cwd, "long.ts"), lines([0, "one AGENT"]));
    const first = await landAgent(worktrees, isolatedAgent(fresh.repos));
    expect(first.landed).toBe(true);
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "commit landed work");
    // Main also gains someone else's edit at the bottom of the same file.
    await writeFile(join(work, "long.ts"), lines([0, "one AGENT"], [6, "seven OTHERS"]));
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "someone else");
    // The agent syncs main into its branch: an edit whose hunk context reaches the line someone else changed.
    await sh(fresh.cwd, "-c", "user.name=t", "-c", "user.email=t@t", "merge", "-q", "-m", "sync", await sh(work, "rev-parse", "HEAD"));
    await writeFile(join(fresh.cwd, "long.ts"), lines([0, "one AGENT"], [6, "seven OTHERS"], [3, "four AGAIN"]));

    const second = await landAgent(worktrees, isolatedAgent(first.repos));
    expect(second.landed).toBe(true);
    expect(second.conflicts).toBeUndefined();
    expect(await readFile(join(work, "long.ts"), "utf8")).toBe(lines([0, "one AGENT"], [6, "seven OTHERS"], [3, "four AGAIN"]));
});

// Git tracks no directories: a land prunes the chain its own removal empties, and nothing else.
test("a land that deletes a folder's last file takes the emptied chain with it", async () => {
    const { work, worktrees } = await setup();
    await mkdir(join(work, "src/old/deep"), { recursive: true });
    await writeFile(join(work, "src/old/deep/legacy.ts"), "old\n");
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "nested");
    const conversation = await worktrees.ensure("c2", []);
    await rm(join(conversation.cwd, "src/old/deep/legacy.ts"));

    const result = await landAgent(worktrees, isolatedAgent(conversation.repos, { id: `c2` }));
    expect(result.landed).toBe(true);
    expect(existsSync(join(work, "src"))).toBe(false);
    expect(existsSync(join(work, "app.ts"))).toBe(true);
});

test("the subset land (part of the delta already in main) also prunes what its removals empty", async () => {
    const { work, worktrees } = await setup();
    await mkdir(join(work, "src/old"), { recursive: true });
    await writeFile(join(work, "src/old/legacy.ts"), "old\n");
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "nested");
    const conversation = await worktrees.ensure("c2", []);
    // The user already applied app.ts by hand, so the bulk check fails and only the deletion takes the subset path.
    await rm(join(conversation.cwd, "src/old/legacy.ts"));
    await writeFile(join(conversation.cwd, "app.ts"), "line one EDITED\nline two\nline three\n");
    await writeFile(join(work, "app.ts"), "line one EDITED\nline two\nline three\n");

    const result = await landAgent(worktrees, isolatedAgent(conversation.repos, { id: `c2` }));
    expect(result.landed).toBe(true);
    expect(existsSync(join(work, "src"))).toBe(false);
});

// The patch used to ride through the git runner's stdout (16 MiB ceiling), so this needs a genuinely oversized patch.
// Incompressible bytes on purpose: a compressible blob would deflate under the ceiling and pass for the wrong reason.
test("a delta whose patch is larger than the runner's 16 MiB stdout ceiling still lands", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "big.bin"), randomBytes(18 * 1024 * 1024));

    const result = await landAgent(worktrees, isolatedAgent(conversation.repos));

    expect(result.landed).toBe(true);
    expect(result.conflicts).toBeUndefined();
    expect((await stat(join(work, "big.bin"))).size).toBe(18 * 1024 * 1024);
    // Piped to `wc` so the test's own exec isn't what blows up carrying the patch.
    const tip = await sh(conversation.cwd, "rev-parse", "HEAD");
    const bytes = await exec("bash", ["-c", `git -C ${work} diff --binary -M HEAD ${tip} | wc -c`]);
    expect(Number(bytes.stdout.trim())).toBeGreaterThan(16 * 1024 * 1024);
});

// `binary` outranks the other reasons, read off git's numstat rather than a string search on the patch.
test("a binary file both sides changed conflicts as `binary`, not `workspace`", async () => {
    const { work, worktrees } = await setup();
    await writeFile(join(work, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "logo");
    const conversation2 = await worktrees.ensure("c2", []);
    await writeFile(join(conversation2.cwd, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xaa, 0xbb]));
    await writeFile(join(work, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xcc, 0xdd]));

    const result = await landAgent(worktrees, isolatedAgent(conversation2.repos, { id: `c2` }));

    expect(result.landed).toBe(false);
    expect(result.conflicts?.[0]?.paths).toEqual([{ path: "logo.png", reason: "binary" }]);
});

test("pruneEmptiedDirs stops at the first level that still holds anything, and at the repo root", async () => {
    const base = await mkdtemp(join(tmpdir(), "intentic-prune-"));
    tempDirs.push(base);
    await mkdir(join(base, "a/b/c"), { recursive: true });
    await writeFile(join(base, "a/keep.txt"), "kept\n");

    await pruneEmptiedDirs(base, ["a/b/c/removed.txt", "top-level-removed.txt"]);

    expect(existsSync(join(base, "a/b"))).toBe(false);
    expect(existsSync(join(base, "a/keep.txt"))).toBe(true);
    expect(existsSync(base)).toBe(true);
});

// The blocked set is read off one whole-patch refusal, not probed per file, so a delta of any size classifies in a
// handful of git runs. Sixty files, refused and clean by turns, cost the per-file road three runs each.
test("a delta with many refusing paths classifies in fewer git runs than it has files", async () => {
    const { work, worktrees } = await setup();
    const count = 60;
    for (let index = 0; index < count; index += 1) {
        await writeFile(join(work, `f${index}.ts`), "line one\nline two\nline three\n");
    }
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "many files");
    const conversation = await worktrees.ensure("c2", []);
    for (let index = 0; index < count; index += 1) {
        await writeFile(join(conversation.cwd, `f${index}.ts`), `line one AGENT ${index}\nline two\nline three\n`);
        if (index % 2 === 0) {
            await writeFile(join(work, `f${index}.ts`), `line one USER ${index}\nline two\nline three\n`);
        }
    }
    let runs = 0;
    const counting: typeof defaultGit = (dir, args, env) => {
        runs += 1;
        return defaultGit(dir, args, env);
    };

    const result = await landAgent(worktrees, isolatedAgent(conversation.repos, { id: "c2" }), "check", "outstanding", counting);

    expect(result.landed).toBe(false);
    expect(result.conflicts?.[0]?.paths).toHaveLength(count / 2);
    expect(result.conflicts?.[0]?.paths.every((conflict) => conflict.reason === "workspace")).toBe(true);
    expect(result.conflicts?.[0]?.clean).toBe(count / 2);
    expect(runs).toBeLessThan(count);
});

// `git apply --check` passes a symlink over a directory (a directory may stand where a file will go) and the write then
// refuses: reported as this repo's conflict at the path, rather than thrown as an error naming nothing.
test("a write the tree refuses after a clean preflight reports the path as a conflict instead of throwing", async () => {
    const { work, worktrees } = await setup();
    await mkdir(join(work, "pkg"), { recursive: true });
    await writeFile(join(work, "pkg", "index.ts"), "export {};\n");
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "pkg");
    // Main holds a real, populated directory where the branch puts a symlink; untracked, so no diff sees it. Not a
    // mirrored dir (node_modules, dist, .venv, generated): a worktree links those in itself and excludes them, so no
    // delta can carry one.
    await mkdir(join(work, "pkg", "vendor", "dep"), { recursive: true });
    await writeFile(join(work, "pkg", "vendor", "dep", "index.js"), "module.exports = {};\n");
    const conversation = await worktrees.ensure("c2", []);
    await symlink("../shared", join(conversation.cwd, "pkg", "vendor"));
    await writeFile(join(conversation.cwd, "pkg", "index.ts"), "export const x = 1;\n");

    const result = await landAgent(worktrees, isolatedAgent(conversation.repos, { id: "c2" }));

    expect(result.landed).toBe(false);
    expect(result.conflicts).toEqual([{ repo: "root", paths: [{ path: "pkg/vendor", reason: "workspace" }], clean: 1, mainBranch: "main" }]);
    expect(existsSync(join(work, "pkg", "vendor", "dep", "index.js"))).toBe(true);
    // Refused before any tip moved: the next land carries the same delta.
    expect(result.repos.find((repo) => repo.repo === "root")?.landedTip).toBeUndefined();
});
