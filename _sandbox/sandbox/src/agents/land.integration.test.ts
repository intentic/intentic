import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { defaultGit } from "@intentic/scaffold";
import { afterEach, expect, test } from "vitest";
import { isolatedAgent, noIsolation } from "../testing.js";
import { changesAgainstBase } from "../git/changes.js";
import { ensureRootRepo } from "../git/root-repo.js";
import { createLogger } from "../logger.js";
import { createPerfTracker } from "../platform/perf.js";
import { workspacePaths } from "../workspace/workspace.js";
import { anchorOf } from "./agent-changes.js";

import { landAgent, outstandingConflicts, pruneEmptiedDirs } from "./land.js";
import { createAgentWorktrees, type AgentWorktrees, type ConversationWorktree } from "./worktrees.js";

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
    // The work arrived, but as plain uncommitted changes: the Changes panel is the review.
    expect(await readFile(join(work, "app.ts"), "utf8")).toBe("line one EDITED\nline two\nline three\n");
    expect(await readFile(join(work, "added.ts"), "utf8")).toBe("new file\n");
    expect(await sh(work, "rev-parse", "HEAD")).toBe(head);
    expect(await sh(work, "status", "--porcelain")).not.toBe("");
    // landedTip advanced to the worktree branch's tip.
    const root = result.repos.find((repo) => repo.repo === "root");
    expect(root?.landedTip).toBe(await sh(conversation.cwd, "rev-parse", "HEAD"));
});

test("nothing to land reads as changed:false (no frame, no status flip)", async () => {
    const { worktrees, conversation } = await setup();
    const result = await landAgent(worktrees, isolatedAgent(conversation.repos));
    expect(result).toMatchObject({ landed: true, changed: false });
    expect(result.diff).toEqual({ files: 0, insertions: 0, deletions: 0 });
});

test("land reports the agent's cumulative diffstat (files, +insertions, −deletions)", async () => {
    const { worktrees, conversation } = await setup();
    // app.ts: one line replaced (1 insertion + 1 deletion); added.ts: 2 new lines.
    await writeFile(join(conversation.cwd, "app.ts"), "line one EDITED\nline two\nline three\n");
    await writeFile(join(conversation.cwd, "added.ts"), "new file\nsecond line\n");

    const first = await landAgent(worktrees, isolatedAgent(conversation.repos));
    expect(first.diff).toEqual({ files: 2, insertions: 3, deletions: 1 });

    // Cumulative, not per-land: a second turn's edit re-reports the WHOLE base→tip output.
    await writeFile(join(conversation.cwd, "added.ts"), "new file\nsecond line\nthird line\n");
    const second = await landAgent(worktrees, isolatedAgent(first.repos));
    expect(second.diff).toEqual({ files: 2, insertions: 4, deletions: 1 });
});

test("incremental: a re-touched file lands its second delta onto the previously-landed copy", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), "line one EDITED\nline two\nline three\n");
    const first = await landAgent(worktrees, isolatedAgent(conversation.repos));
    expect(first.landed).toBe(true);

    // Turn 2 edits the SAME file again. Main still holds the landed (uncommitted) copy: the patch context
    // matches it, so the second delta applies; a path-overlap test would have false-flagged this.
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
    // `workspace` is the one cause where the copy at risk is the USER'S, which is what the report has to say.
    expect(result.conflicts).toEqual([{ repo: "root", paths: [{ path: "app.ts", reason: "workspace" }], clean: 0, mainBranch: "main" }]);
    expect(await readFile(join(work, "app.ts"), "utf8")).toBe("line one USER\nline two\nline three\n");
    // The agent's work is intact in the worktree for Land-now recovery.
    expect(await readFile(join(conversation.cwd, "app.ts"), "utf8")).toBe("line one AGENT\nline two\nline three\n");
});

test("names only the paths that actually refuse, and counts what would land anyway", async () => {
    const { work, worktrees, conversation } = await setup();
    // The agent touches two files; the user has edited only one of them.
    await writeFile(join(conversation.cwd, "app.ts"), "line one AGENT\nline two\nline three\n");
    await writeFile(join(conversation.cwd, "added.ts"), "brand new\n");
    await writeFile(join(work, "app.ts"), "line one USER\nline two\nline three\n");

    const result = await landAgent(worktrees, isolatedAgent(conversation.repos));

    // `git apply` is atomic, so BOTH files are held back, but only one of them is the reason, and saying so
    // is the difference between "resolve this file" and a wall of every path the agent ever touched.
    expect(result.conflicts).toEqual([{ repo: "root", paths: [{ path: "app.ts", reason: "workspace" }], clean: 1, mainBranch: "main" }]);
    expect(existsSync(join(work, "added.ts"))).toBe(false);
});

/* The stored report is a snapshot of land time, and its `workspace` reason is the one that rots: the user
 * clears their uncommitted copy by COMMITTING, which no land observes. Served verbatim, the old report kept
 * telling them "commit or stash" over a spotless tree, and kept the resolve flow refusing to hand the
 * conflict to the agent, though a rebase is now exactly what would fix it. */
test("a workspace refusal re-derives as diverged once the user commits their edit", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), "line one AGENT\nline two\nline three\n");
    await writeFile(join(work, "app.ts"), "line one USER\nline two\nline three\n");
    const entry = isolatedAgent(conversation.repos);
    const refusal = await landAgent(worktrees, entry);
    expect(refusal.conflicts).toEqual([{ repo: "root", paths: [{ path: "app.ts", reason: "workspace" }], clean: 0, mainBranch: "main" }]);

    // While the user's copy is still dirty, the re-derivation agrees with the stored report.
    expect(await outstandingConflicts(worktrees, entry)).toEqual(refusal.conflicts);

    // The user does what the report asked: commits. No land runs, so the STORED report still says
    // `workspace`; the re-derivation moves with the world: the same blocker is now a committed divergence.
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

    // The user undoes their edit instead: the delta applies cleanly now, so there is no refusal to report.
    await writeFile(join(work, "app.ts"), "line one\nline two\nline three\n");
    expect(await outstandingConflicts(worktrees, entry)).toEqual([]);
});

test("blames the moved main line, not the workspace, when the conflict is a committed divergence", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), "line one AGENT\nline two\nline three\n");
    // The main line moves on and COMMITS: the working tree is spotless, so the old dirty-overlap heuristic
    // found nothing to blame and fell back to naming the entire delta.
    await writeFile(join(work, "app.ts"), "line one MAIN\nline two\nline three\n");
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "main moved");

    const result = await landAgent(worktrees, isolatedAgent(conversation.repos));

    // Nothing of the user's is at risk here, and the report has to say which of the two situations this is.
    expect(result.conflicts).toEqual([{ repo: "root", paths: [{ path: "app.ts", reason: "diverged" }], clean: 0, mainBranch: "main" }]);
});

test("re-anchors on the merge-base, so an agent rebased onto the moved main line still lands its own work", async () => {
    const { work, worktrees, conversation } = await setup();
    const recorded = isolatedAgent(conversation.repos);
    await writeFile(join(conversation.cwd, "agent.ts"), "agent work\n");
    await sh(conversation.cwd, "add", "-A");
    await sh(conversation.cwd, "-c", "user.name=a", "-c", "user.email=a@a", "commit", "-q", "-m", "agent");

    // The main line moves on, in a file the agent never touched.
    await writeFile(join(work, "main-only.ts"), "main work\n");
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "main moved");
    // The user rebases the agent onto it: the natural response to being told main moved on. The branch now
    // CONTAINS main's commit, so a delta measured from the frozen base would carry that commit back onto main
    // and fail wholesale, naming files the agent never opened.
    await sh(conversation.cwd, "-c", "user.name=a", "-c", "user.email=a@a", "rebase", await sh(work, "rev-parse", "HEAD"));

    const result = await landAgent(worktrees, recorded);

    expect(result.conflicts).toBeUndefined();
    expect(result.landed).toBe(true);
    expect(await readFile(join(work, "agent.ts"), "utf8")).toBe("agent work\n");
    expect(await readFile(join(work, "main-only.ts"), "utf8")).toBe("main work\n");
});

/* The failure this pair exists to prevent: an agent that put its OWN work on the main line, pushed to main,
 * or had the user commit its branch by hand: arriving as a different commit than the one on its branch. The
 * merge-base anchor cannot see that (ancestry says the work is unmerged), so the patch re-offers content the
 * main tree already holds and every path of it refuses to apply. Reported as a conflict, that is a dead end:
 * a red card naming files the user never touched, with nothing to resolve and no way to clear it. */
test("work the agent committed onto the main line itself lands as a no-op instead of conflicting", async () => {
    const { work, worktrees, conversation } = await setup();
    const recorded = isolatedAgent(conversation.repos);
    await writeFile(join(conversation.cwd, "agent.ts"), "agent work\n");
    await writeFile(join(conversation.cwd, "app.ts"), "line one AGENT\nline two\nline three\n");
    await sh(conversation.cwd, "add", "-A");
    await sh(conversation.cwd, "-c", "user.name=a", "-c", "user.email=a@a", "commit", "-q", "-m", "agent");
    // The same content reaches main as its OWN commit: identical tree, unrelated sha.
    await writeFile(join(work, "agent.ts"), "agent work\n");
    await writeFile(join(work, "app.ts"), "line one AGENT\nline two\nline three\n");
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "the same work, by hand");

    const result = await landAgent(worktrees, recorded);

    expect(result.conflicts).toBeUndefined();
    expect(result.landed).toBe(true);
    // Nothing was applied and nothing was disturbed: main is exactly where its own commit left it.
    expect(await sh(work, "status", "--porcelain")).toBe("");
    // The tip advances regardless: without it every later land re-offers this same delta forever.
    expect(result.repos[0]?.landedTip).toBe(await sh(conversation.cwd, "rev-parse", "HEAD"));
});

/* The other road work reaches main without landing: the BRANCH ITSELF gets merged, an agent told to "land
 * on main" runs the merge with its own git, or the user merges the branch by hand. Ancestry then says
 * everything is merged (the merge-base IS the tip), so land rightly applies nothing, but it must still SAY
 * SO: with landedTip left behind, the review counts every file as "not landed" forever, Land now stays armed
 * doing nothing, and a conflict report from before the merge never clears. */
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
    // A real outcome, not a silent no-op: changed makes the caller persist the tip and clear old conflicts.
    expect(result.changed).toBe(true);
    expect(result.repos[0]?.landedTip).toBe(tip);
    // Nothing was applied and nothing was disturbed: main is exactly where its merge commit left it.
    expect(await sh(work, "status", "--porcelain")).toBe("");

    // With the tip recorded, the NEXT land is the true no-op: no frame, no status flip.
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
    // Only one of the two files was carried over to main.
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
    // The main line moved on and committed, so the workspace is clean, which is what lets git merge at all.
    await writeFile(join(work, "app.ts"), "line one MAIN\nline two\nline three\n");
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "main moved");

    const result = await landAgent(worktrees, isolatedAgent(conversation.repos), "merge");

    // The clean file is no longer held hostage by the conflicted one.
    expect(await readFile(join(work, "added.ts"), "utf8")).toBe("brand new\n");
    // ...and the conflicted one arrives in the shape any merge leaves behind, to finish in place.
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

    // `--3way` goes through the index and refuses on an unstaged path, applying NOTHING, so the honest
    // outcome is the same report `check` gives, and the user commits or stashes their copy first.
    expect(result.resolving).toBeUndefined();
    expect(result.conflicts).toEqual([{ repo: "root", paths: [{ path: "app.ts", reason: "workspace" }], clean: 0, mainBranch: "main" }]);
    expect(await readFile(join(work, "app.ts"), "utf8")).toBe("line one USER\nline two\nline three\n");
});

test("a user edit ELSEWHERE in the same file still lands (patch context, not path sets)", async () => {
    const { work, worktrees } = await setup();
    // Far enough apart that the hunks' ±3 context lines never overlap (a 3-line file would make any
    // same-file edit a context collision: that's the conflict test, not this one).
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
    /* A workspace repo cloned under /work AFTER root's exclude list was derived, which is the state that made
     * this hard: root's `add -A` in the conversation's worktree stages the repo dir as a gitlink, and root's
     * view of the agent's work is "modified: inner (modified content)", dirt nothing can stage, because a
     * gitlink moves only when the nested repo's own HEAD does. Root is landed FIRST (the composition is
     * ["root", ...discovered]), so committing on that verdict used to abort the whole land with git's "no
     * changes added to commit": a 500 on POST /agents/{id}/land, with the agent's work stranded. Root keeps
     * the repo out of its commit either way (git/root-repo.ts), so what it has to land stays nothing. */
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
    // Root landed nothing and claims nothing: its worktree branch never moved, so landedTip stays unset.
    expect(result.repos.find((repo) => repo.repo === "root")?.landedTip).toBeUndefined();
    expect(result.repos.find((repo) => repo.repo === "inner")?.landedTip).toBe(await sh(worktrees.worktreeDir("c2", "inner"), "rev-parse", "HEAD"));
});

/* A RETIRED checkout (an archived agent, or a restored one whose next turn hasn't re-attached it yet) is not
 * "nothing to land": retire commits the worktree's remainder onto agent/<id>, so the branch holds everything
 * and the shared object store makes it readable from the main repo. Skipping the repo: the old behavior:
 * returned landed:true having landed NOTHING, which stamped the card Landed over a review still counting
 * every file as pending, with Land now armed and useless. */
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
    // The cumulative diffstat still reports: the card's numbers survive the retired checkout.
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

    // changed:false keeps the frame and status flip away; diff.files>0 is what lets the caller keep the
    // settled status at "landed" rather than downgrading to idle.
    expect(again).toMatchObject({ landed: true, changed: false });
    expect(again.diff.files).toBe(1);
});

test("a discard fired during an in-flight land queues behind the repo lock: land finishes first", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), "line one AGENT\nline two\nline three\n");

    // Freeze the land inside its critical section: the first `apply --check` blocks until released. A discard
    // from a second browser passes the registry's notRunning guard (it only tracks streaming turns), so the
    // per-repo lock is the ONLY thing keeping `worktree remove --force` out of a half-applied land.
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
    expect(removed).toBe(false); // serialized behind the land's lock, not interleaved into it

    release();
    const result = await landing;
    await removing;
    expect(result.landed).toBe(true);
    // The land won the race: its delta is in main (uncommitted), and the discard then removed the worktree.
    expect(await readFile(join(work, "app.ts"), "utf8")).toBe("line one AGENT\nline two\nline three\n");
    expect(existsSync(worktrees.worktreeDir("c1", "root"))).toBe(false);
});

test("a fully reverted delta lands as a no-op: landedTip advances, no phantom conflict", async () => {
    const { work, worktrees, conversation } = await setup();
    // Turn 1 edits and commits; turn 2 reverts to the exact base content. tip ≠ base, but the base→tip
    // patch is EMPTY: `git apply` rejects an empty patch, so without the net-zero branch this range would
    // re-report a conflict (with no paths to resolve) on every future land, forever.
    await writeFile(join(conversation.cwd, "app.ts"), "line one EDITED\nline two\nline three\n");
    await sh(conversation.cwd, "add", "-A");
    await sh(conversation.cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "edit");
    await writeFile(join(conversation.cwd, "app.ts"), "line one\nline two\nline three\n");

    const result = await landAgent(worktrees, isolatedAgent(conversation.repos));
    expect(result.landed).toBe(true);
    expect(result.conflicts).toBeUndefined();
    expect(await sh(work, "status", "--porcelain")).toBe("");
    // landedTip advanced past the reverted range…
    expect(result.repos.find((repo) => repo.repo === "root")?.landedTip).toBe(await sh(conversation.cwd, "rev-parse", "HEAD"));
    // …so the next land is a clean no-op (no frame, no status flip), not a replay.
    const again = await landAgent(worktrees, isolatedAgent(result.repos));
    expect(again).toMatchObject({ landed: true, changed: false });
});

/* MEASURE MODE, auto-land off. Everything a land does except touching the main tree: the provenance commit,
 * the diffstat and the already-in-main bookkeeping all run, and the outstanding delta is reported `held`
 * rather than applied: the caller stamps the card "Ready to land" on it. */
test("measure holds the delta on the branch: nothing applies, tips stay, the diffstat still reports", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), "line one EDITED\nline two\nline three\n");
    await writeFile(join(conversation.cwd, "added.ts"), "new file\n");

    const result = await landAgent(worktrees, isolatedAgent(conversation.repos), "measure");

    // A real outcome (the caller persists and flips status on it), but not a landed one and not a refusal.
    expect(result).toMatchObject({ landed: false, changed: true, held: true });
    expect(result.conflicts).toBeUndefined();
    // The main tree is byte-identical: the whole point of holding.
    expect(await readFile(join(work, "app.ts"), "utf8")).toBe("line one\nline two\nline three\n");
    expect(existsSync(join(work, "added.ts"))).toBe(false);
    expect(await sh(work, "status", "--porcelain")).toBe("");
    // The card's numbers stay as current as a landed agent's.
    expect(result.diff).toEqual({ files: 2, insertions: 2, deletions: 1 });
    // landedTip did NOT advance: the eventual deliberate land carries this exact delta…
    expect(result.repos.find((repo) => repo.repo === "root")?.landedTip).toBeUndefined();
    // …and the provenance commit happened: the worktree's dirty state is safe on agent/c1.
    expect(await sh(conversation.cwd, "status", "--porcelain")).toBe("");

    // The deliberate land is an ordinary check land of the cumulative delta.
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
    // The same content reaches main as its OWN commit: a held card offering to land this could never do
    // anything, which is the dead end the reverse probe exists to rule out.
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

test("deletes and renames land; a conflicted land keeps landedTip so recovery applies the same delta", async () => {
    const { work, worktrees, conversation } = await setup();
    await sh(conversation.cwd, "mv", "app.ts", "renamed.ts");
    await sh(conversation.cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "rename");

    const result = await landAgent(worktrees, isolatedAgent(conversation.repos));
    expect(result.landed).toBe(true);
    expect(existsSync(join(work, "app.ts"))).toBe(false);
    expect(await readFile(join(work, "renamed.ts"), "utf8")).toBe("line one\nline two\nline three\n");

    // Conflict a follow-up: agent edits renamed.ts, user edits the main copy on the same line.
    await writeFile(join(conversation.cwd, "renamed.ts"), "line one AGENT\nline two\nline three\n");
    await writeFile(join(work, "renamed.ts"), "line one USER\nline two\nline three\n");
    const conflicted = await landAgent(worktrees, isolatedAgent(result.repos));
    expect(conflicted.landed).toBe(false);
    // landedTip did NOT advance for the conflicted repo: Land now retries the exact same delta.
    expect(conflicted.repos.find((repo) => repo.repo === "root")?.landedTip).toBe(result.repos.find((repo) => repo.repo === "root")?.landedTip);
    // User resolves (reverts their edit) → recovery lands the pending delta.
    await writeFile(join(work, "renamed.ts"), "line one\nline two\nline three\n");
    const recovered = await landAgent(worktrees, isolatedAgent(conflicted.repos));
    expect(recovered.landed).toBe(true);
    expect(await readFile(join(work, "renamed.ts"), "utf8")).toBe("line one AGENT\nline two\nline three\n");
});

/* THE RENAME THAT LANDED HALF-APPLIED. Whole-delta landing has always carried renames correctly (the test
 * above); the SUBSET land did not, and the two only meet when part of a delta is already in the main tree: a
 * combination nothing covered, which is how this shipped.
 *
 * The mechanism, in one line: the subset was described by PATHS, and `git diff --name-only` names a rename at
 * its destination and nowhere else, so the pathspec built from it could no longer express the rename. `-M` had
 * nothing to pair, emitted a bare creation, and the apply wrote the new file while leaving the old one in the
 * tree. The user's commit then recorded the stale copy as still-present, and it surfaced later as a deletion
 * with no author. See land.ts DeltaChange. */
test("a rename landing as part of a half-landed delta leaves no stale source behind", async () => {
    const { work, worktrees, conversation } = await setup();
    const recorded = isolatedAgent(conversation.repos);
    await sh(conversation.cwd, "mv", "app.ts", "moved.ts");
    await writeFile(join(conversation.cwd, "already.ts"), "already on main\n");
    await sh(conversation.cwd, "add", "-A");
    await sh(conversation.cwd, "-c", "user.name=a", "-c", "user.email=a@a", "commit", "-q", "-m", "rename plus a file");
    // Half of the delta reached main by another road, so the whole patch can no longer apply atomically and the
    // land falls back to carrying only the outstanding remainder: here, the rename.
    await writeFile(join(work, "already.ts"), "already on main\n");
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "half of it, by hand");

    const result = await landAgent(worktrees, recorded);

    expect(result.conflicts).toBeUndefined();
    expect(result.landed).toBe(true);
    expect(await readFile(join(work, "moved.ts"), "utf8")).toBe("line one\nline two\nline three\n");
    // The delete leg. This is the assertion the bug failed.
    expect(existsSync(join(work, "app.ts"))).toBe(false);
});

// The same subset land carrying an outright DELETION: the other change whose whole content is the removal of a
// path, and so the other one a pathspec-built patch can silently decline to express.
test("a deletion landing as part of a half-landed delta removes the file", async () => {
    const { work, worktrees } = await setup();
    await writeFile(join(work, "doomed.ts"), "delete me\n");
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "a file to delete");
    // A checkout taken AFTER that commit, so the branch has the file to delete: setup()'s own predates it.
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

/* The classifier's own half of the same defect. A rename-WITH-EDITS probed at its destination alone is a bare
 * file creation, and a creation applies against any tree whatsoever, so the user's conflicting edit to the
 * SOURCE was invisible to the probe and the change got called clean. The probe now spans both legs, which is
 * what lets the pre-image hunks meet the user's copy and refuse.
 *
 * (A 100%-similarity rename is a different case and not a conflict: it carries no hunks, so git renames the
 * user's content to the new path and nothing is lost, which is what `git mv` on a dirty file does too.) */
test("a user edit under a rename-with-edits is a conflict, not a clean change", async () => {
    const { work, worktrees, conversation } = await setup();
    await sh(conversation.cwd, "mv", "app.ts", "moved.ts");
    await writeFile(join(conversation.cwd, "moved.ts"), "line one AGENT\nline two\nline three\n");
    await sh(conversation.cwd, "add", "-A");
    await sh(conversation.cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "rename and edit");
    await writeFile(join(work, "app.ts"), "line one USER\nline two\nline three\n");

    const result = await landAgent(worktrees, isolatedAgent(conversation.repos));

    expect(result.landed).toBe(false);
    // Reported at the destination (the path the user will go looking for) with their own copy as the cause.
    expect(result.conflicts).toEqual([{ repo: "root", paths: [{ path: "moved.ts", reason: "workspace" }], clean: 0, mainBranch: "main" }]);
    // `check` promises a refusal changes nothing: the user's edit stands and no half-rename was written.
    expect(await readFile(join(work, "app.ts"), "utf8")).toBe("line one USER\nline two\nline three\n");
    expect(existsSync(join(work, "moved.ts"))).toBe(false);
});

/* The review's span, measured the way the diff route now measures it (agent-changes.ts → anchorOf without
 * the landedTip rung). The bug this pins down: an agent whose worktree fast-forwarded onto newer main
 * commits reviewed everything main gained in between as ITS OWN output: one real card showed a hundred
 * files of other agents' landed work under "the isolated branch this agent works on". */
test("a worktree synced onto newer main commits does not review main's work as its own", async () => {
    const { work, conversation } = await setup();
    const base = conversation.repos.find((repo) => repo.repo === "root")?.base ?? "";
    // Someone else's work lands and is committed on the MAIN line after this agent's worktree was created.
    await writeFile(join(work, "foreign.ts"), "someone else's work\n");
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "foreign");
    // The agent syncs its branch up to the moved main line (the turn-start fast-forward), then works.
    await sh(conversation.cwd, "merge", "--ff-only", await sh(work, "rev-parse", "HEAD"));
    await writeFile(join(conversation.cwd, "own.ts"), "this agent's work\n");

    const anchor = await anchorOf(conversation.cwd, work, "agent/c1", undefined, base);
    expect((await changesAgainstBase(conversation.cwd, anchor)).map((change) => change.path)).toEqual(["own.ts"]);
    // The frozen creation-time base tells the broken story this replaced.
    expect((await changesAgainstBase(conversation.cwd, base)).map((change) => change.path)).toContain("foreign.ts");
});

/* The CARD's counter over that same sequence: the half that was still measuring from the frozen base long
 * after the review stopped. The card kept its own `git diff --shortstat base tip`, so a synced worktree
 * reported "336 files · +15604 −4427" on the board over a review listing six files and +446: the difference
 * was every commit main had gained since the checkout, counted as this agent's output. One reading now
 * (agent-changes.ts), totalled here and listed there. */
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

/* The exact sequence that stranded a real card on "1 file couldn't be applied": land → the user commits the
 * landed content on main → main also gains someone else's work → the agent merges main into its branch and
 * keeps working → land again. The landedTip-spanned patch carries pre-images main has moved past (the second
 * edit's hunk context reaches lines someone else changed), so the land read as a conflict the merge had
 * already reconciled. The merge-base must supersede the stale landedTip. */
test("after merging main into the branch, land measures from the merge-base, not the stale landedTip", async () => {
    const { work, worktrees, conversation } = await setup();
    const lines = (...replaced: [number, string][]): string =>
        ["one", "two", "three", "four", "five", "six", "seven"].map((word, at) => replaced.find(([i]) => i === at)?.[1] ?? word).join("\n") + "\n";
    await writeFile(join(work, "long.ts"), lines());
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "long file");
    await worktrees.remove("c1", conversation.repos);
    const fresh = await worktrees.ensure("c1", []);

    // Turn 1: edit the top + land + the user commits the landed content on main.
    await writeFile(join(fresh.cwd, "long.ts"), lines([0, "one AGENT"]));
    const first = await landAgent(worktrees, isolatedAgent(fresh.repos));
    expect(first.landed).toBe(true);
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "commit landed work");
    // Main also gains someone else's edit at the bottom of the same file.
    await writeFile(join(work, "long.ts"), lines([0, "one AGENT"], [6, "seven OTHERS"]));
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "someone else");
    // The agent syncs (merge main into its branch) and keeps working: an edit whose hunk CONTEXT reaches
    // the line someone else changed, which is what made the stale-anchored patch unapplicable.
    await sh(fresh.cwd, "-c", "user.name=t", "-c", "user.email=t@t", "merge", "-q", "-m", "sync", await sh(work, "rev-parse", "HEAD"));
    await writeFile(join(fresh.cwd, "long.ts"), lines([0, "one AGENT"], [6, "seven OTHERS"], [3, "four AGAIN"]));

    const second = await landAgent(worktrees, isolatedAgent(first.repos));
    // Without the merge-base rung superseding landedTip this reported a conflict on long.ts.
    expect(second.landed).toBe(true);
    expect(second.conflicts).toBeUndefined();
    expect(await readFile(join(work, "long.ts"), "utf8")).toBe(lines([0, "one AGENT"], [6, "seven OTHERS"], [3, "four AGAIN"]));
});

/* A DELETION'S DEBRIS. Git tracks no directories, so the folder a deletion empties would sit in the main tree
 * forever: untracked, invisible to every git verb, and the user's to notice. A land takes its own debris with
 * it: whichever apply path carried the removal, the emptied chain is gone afterwards, and folders the land did
 * NOT empty are never touched. */
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
    // The whole chain, not just the file: src held nothing but the emptiness below it.
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
    // The agent deletes the nested file AND edits app.ts, and the user has already applied the app.ts edit
    // to main by hand, so the bulk check fails, classifyDelta drops that change as already-in-main, and the
    // remainder (the deletion) goes through applyChanges: the subset path.
    await rm(join(conversation.cwd, "src/old/legacy.ts"));
    await writeFile(join(conversation.cwd, "app.ts"), "line one EDITED\nline two\nline three\n");
    await writeFile(join(work, "app.ts"), "line one EDITED\nline two\nline three\n");

    const result = await landAgent(worktrees, isolatedAgent(conversation.repos, { id: `c2` }));
    expect(result.landed).toBe(true);
    expect(existsSync(join(work, "src"))).toBe(false);
});

/* THE SIZE CEILING THAT KILLED FINISHED WORK.
 *
 * The patch used to come back through the git runner's stdout, which rejects past 16 MiB, so a change bigger
 * than that failed the hand-over with `stdout maxBuffer length exceeded` AFTER the turn had done its work: the
 * session was marked failed, the delta stayed on the branch, and the message named neither the size nor the
 * step. It took twenty-three retaken product screenshots (a 51 MiB binary patch) to hit in the wild, so the
 * guard has to be a genuinely oversized patch rather than a mocked runner.
 *
 * Incompressible bytes on purpose: `--binary` deflates before base85, so a compressible blob of the same length
 * produces a patch of almost nothing and the test would pass without ever crossing the ceiling. The assertion on
 * the patch's own size is what keeps this test honest if that ever changes.
 */
test("a delta whose patch is larger than the runner's 16 MiB stdout ceiling still lands", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "big.bin"), randomBytes(18 * 1024 * 1024));

    const result = await landAgent(worktrees, isolatedAgent(conversation.repos));

    expect(result.landed).toBe(true);
    expect(result.conflicts).toBeUndefined();
    expect((await stat(join(work, "big.bin"))).size).toBe(18 * 1024 * 1024);
    // The patch this land had to carry, measured the way the ceiling measured it. Piped to `wc` so the test's
    // own exec is not the thing that blows up on it.
    const tip = await sh(conversation.cwd, "rev-parse", "HEAD");
    const bytes = await exec("bash", ["-c", `git -C ${work} diff --binary -M HEAD ${tip} | wc -c`]);
    expect(Number(bytes.stdout.trim())).toBeGreaterThan(16 * 1024 * 1024);
});

// `binary` outranks the other two reasons because no three-way merge of it exists to offer, and it is now read
// off git's numstat (both counts omitted) rather than off a "GIT binary patch" substring in a patch this no
// longer holds as a string.
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

// The prune itself, off the git path: climbs exactly as far as the removal emptied, and no further.
test("pruneEmptiedDirs stops at the first level that still holds anything, and at the repo root", async () => {
    const base = await mkdtemp(join(tmpdir(), "intentic-prune-"));
    tempDirs.push(base);
    await mkdir(join(base, "a/b/c"), { recursive: true });
    await writeFile(join(base, "a/keep.txt"), "kept\n");

    await pruneEmptiedDirs(base, ["a/b/c/removed.txt", "top-level-removed.txt"]);

    expect(existsSync(join(base, "a/b"))).toBe(false); // the emptied chain
    expect(existsSync(join(base, "a/keep.txt"))).toBe(true); // the stop
    expect(existsSync(base)).toBe(true); // a root-level removal never climbs out
});
