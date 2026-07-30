import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { defaultGit } from "@intentic/scaffold";
import { afterEach, expect, test } from "vitest";
import { changesAgainstBase } from "../git/changes.js";
import { ensureRootRepo } from "../git/root-repo.js";
import { createLogger } from "../logger.js";
import { workspacePaths } from "../workspace/workspace.js";
import type { PersistedAgent } from "./agents-store.js";
import { anchorOf, landAgent, outstandingConflicts } from "./land.js";
import { createAgentWorktrees, type AgentWorktrees, type ConversationWorktree } from "./worktrees.js";

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });

// No mount namespace here: these suites assert the SYMLINK mirroring, which is what a container without
// CAP_SYS_ADMIN (and every test runner) actually gets. The bind-mount branch is isolation.test.ts's.
const noIsolation = { available: async () => false, planFor: async () => undefined };

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
    const worktrees = createAgentWorktrees({ workspace, worktreesRoot: join(historyRoot, "worktrees"), historyRoot, isolation: noIsolation, logger });
    const conversation = await worktrees.ensure("c1", []);
    return { work, worktrees, conversation };
};

const entryFor = (repos: PersistedAgent["repos"]): PersistedAgent => ({
    id: "c1",
    branch: "agent/c1",
    title: "fix the thing",
    provider: "claude",
    harness: "native",
    repos: [...repos],
    status: "idle",
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    createdAt: 0,
    updatedAt: 0,
});

test("land applies the delta as UNCOMMITTED main-tree changes — HEAD never moves", async () => {
    const { work, worktrees, conversation } = await setup();
    const head = await sh(work, "rev-parse", "HEAD");
    await writeFile(join(conversation.cwd, "app.ts"), "line one EDITED\nline two\nline three\n");
    await writeFile(join(conversation.cwd, "added.ts"), "new file\n");

    const result = await landAgent(worktrees, entryFor(conversation.repos));
    expect(result.landed).toBe(true);
    expect(result.changed).toBe(true);
    // The work arrived, but as plain uncommitted changes — the Changes panel is the review.
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
    const result = await landAgent(worktrees, entryFor(conversation.repos));
    expect(result).toMatchObject({ landed: true, changed: false });
    expect(result.diff).toEqual({ files: 0, insertions: 0, deletions: 0 });
});

test("land reports the agent's cumulative diffstat (files, +insertions, −deletions)", async () => {
    const { worktrees, conversation } = await setup();
    // app.ts: one line replaced (1 insertion + 1 deletion); added.ts: 2 new lines.
    await writeFile(join(conversation.cwd, "app.ts"), "line one EDITED\nline two\nline three\n");
    await writeFile(join(conversation.cwd, "added.ts"), "new file\nsecond line\n");

    const first = await landAgent(worktrees, entryFor(conversation.repos));
    expect(first.diff).toEqual({ files: 2, insertions: 3, deletions: 1 });

    // Cumulative, not per-land: a second turn's edit re-reports the WHOLE base→tip output.
    await writeFile(join(conversation.cwd, "added.ts"), "new file\nsecond line\nthird line\n");
    const second = await landAgent(worktrees, entryFor(first.repos));
    expect(second.diff).toEqual({ files: 2, insertions: 4, deletions: 1 });
});

test("incremental: a re-touched file lands its second delta onto the previously-landed copy", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), "line one EDITED\nline two\nline three\n");
    const first = await landAgent(worktrees, entryFor(conversation.repos));
    expect(first.landed).toBe(true);

    // Turn 2 edits the SAME file again. Main still holds the landed (uncommitted) copy — the patch context
    // matches it, so the second delta applies; a path-overlap test would have false-flagged this.
    await writeFile(join(conversation.cwd, "app.ts"), "line one EDITED\nline two\nline three EDITED TOO\n");
    const second = await landAgent(worktrees, entryFor(first.repos));
    expect(second.landed).toBe(true);
    expect(await readFile(join(work, "app.ts"), "utf8")).toBe("line one EDITED\nline two\nline three EDITED TOO\n");
});

test("a user edit on the same lines conflicts: nothing applies, main is untouched, the path is named", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), "line one AGENT\nline two\nline three\n");
    await writeFile(join(work, "app.ts"), "line one USER\nline two\nline three\n");

    const result = await landAgent(worktrees, entryFor(conversation.repos));
    expect(result.landed).toBe(false);
    expect(result.changed).toBe(true);
    // `workspace` is the one cause where the copy at risk is the USER'S, which is what the report has to say.
    expect(result.conflicts).toEqual([{ repo: "root", paths: [{ path: "app.ts", reason: "workspace" }], clean: 0 }]);
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

    const result = await landAgent(worktrees, entryFor(conversation.repos));

    // `git apply` is atomic, so BOTH files are held back — but only one of them is the reason, and saying so
    // is the difference between "resolve this file" and a wall of every path the agent ever touched.
    expect(result.conflicts).toEqual([{ repo: "root", paths: [{ path: "app.ts", reason: "workspace" }], clean: 1 }]);
    expect(existsSync(join(work, "added.ts"))).toBe(false);
});

/* The stored report is a snapshot of land time, and its `workspace` reason is the one that rots: the user
 * clears their uncommitted copy by COMMITTING, which no land observes. Served verbatim, the old report kept
 * telling them "commit or stash" over a spotless tree — and kept the resolve flow refusing to hand the
 * conflict to the agent, though a rebase is now exactly what would fix it. */
test("a workspace refusal re-derives as diverged once the user commits their edit", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), "line one AGENT\nline two\nline three\n");
    await writeFile(join(work, "app.ts"), "line one USER\nline two\nline three\n");
    const entry = entryFor(conversation.repos);
    const refusal = await landAgent(worktrees, entry);
    expect(refusal.conflicts).toEqual([{ repo: "root", paths: [{ path: "app.ts", reason: "workspace" }], clean: 0 }]);

    // While the user's copy is still dirty, the re-derivation agrees with the stored report.
    expect(await outstandingConflicts(worktrees, entry)).toEqual(refusal.conflicts);

    // The user does what the report asked — commits. No land runs, so the STORED report still says
    // `workspace`; the re-derivation moves with the world: the same blocker is now a committed divergence.
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "user commits their half");
    expect(await outstandingConflicts(worktrees, entry)).toEqual([{ repo: "root", paths: [{ path: "app.ts", reason: "diverged" }], clean: 0 }]);
});

test("a refusal whose cause has evaporated re-derives to no conflicts at all", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), "line one AGENT\nline two\nline three\n");
    await writeFile(join(work, "app.ts"), "line one USER\nline two\nline three\n");
    const entry = entryFor(conversation.repos);
    expect((await landAgent(worktrees, entry)).landed).toBe(false);

    // The user undoes their edit instead: the delta applies cleanly now, so there is no refusal to report.
    await writeFile(join(work, "app.ts"), "line one\nline two\nline three\n");
    expect(await outstandingConflicts(worktrees, entry)).toEqual([]);
});

test("blames the moved main line, not the workspace, when the conflict is a committed divergence", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), "line one AGENT\nline two\nline three\n");
    // The main line moves on and COMMITS — the working tree is spotless, so the old dirty-overlap heuristic
    // found nothing to blame and fell back to naming the entire delta.
    await writeFile(join(work, "app.ts"), "line one MAIN\nline two\nline three\n");
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "main moved");

    const result = await landAgent(worktrees, entryFor(conversation.repos));

    // Nothing of the user's is at risk here, and the report has to say which of the two situations this is.
    expect(result.conflicts).toEqual([{ repo: "root", paths: [{ path: "app.ts", reason: "diverged" }], clean: 0 }]);
});

test("re-anchors on the merge-base, so an agent rebased onto the moved main line still lands its own work", async () => {
    const { work, worktrees, conversation } = await setup();
    const recorded = entryFor(conversation.repos);
    await writeFile(join(conversation.cwd, "agent.ts"), "agent work\n");
    await sh(conversation.cwd, "add", "-A");
    await sh(conversation.cwd, "-c", "user.name=a", "-c", "user.email=a@a", "commit", "-q", "-m", "agent");

    // The main line moves on, in a file the agent never touched.
    await writeFile(join(work, "main-only.ts"), "main work\n");
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "main moved");
    // The user rebases the agent onto it — the natural response to being told main moved on. The branch now
    // CONTAINS main's commit, so a delta measured from the frozen base would carry that commit back onto main
    // and fail wholesale, naming files the agent never opened.
    await sh(conversation.cwd, "-c", "user.name=a", "-c", "user.email=a@a", "rebase", await sh(work, "rev-parse", "HEAD"));

    const result = await landAgent(worktrees, recorded);

    expect(result.conflicts).toBeUndefined();
    expect(result.landed).toBe(true);
    expect(await readFile(join(work, "agent.ts"), "utf8")).toBe("agent work\n");
    expect(await readFile(join(work, "main-only.ts"), "utf8")).toBe("main work\n");
});

/* The failure this pair exists to prevent: an agent that put its OWN work on the main line — pushed to main,
 * or had the user commit its branch by hand — arriving as a different commit than the one on its branch. The
 * merge-base anchor cannot see that (ancestry says the work is unmerged), so the patch re-offers content the
 * main tree already holds and every path of it refuses to apply. Reported as a conflict, that is a dead end:
 * a red card naming files the user never touched, with nothing to resolve and no way to clear it. */
test("work the agent committed onto the main line itself lands as a no-op instead of conflicting", async () => {
    const { work, worktrees, conversation } = await setup();
    const recorded = entryFor(conversation.repos);
    await writeFile(join(conversation.cwd, "agent.ts"), "agent work\n");
    await writeFile(join(conversation.cwd, "app.ts"), "line one AGENT\nline two\nline three\n");
    await sh(conversation.cwd, "add", "-A");
    await sh(conversation.cwd, "-c", "user.name=a", "-c", "user.email=a@a", "commit", "-q", "-m", "agent");
    // The same content reaches main as its OWN commit — identical tree, unrelated sha.
    await writeFile(join(work, "agent.ts"), "agent work\n");
    await writeFile(join(work, "app.ts"), "line one AGENT\nline two\nline three\n");
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "the same work, by hand");

    const result = await landAgent(worktrees, recorded);

    expect(result.conflicts).toBeUndefined();
    expect(result.landed).toBe(true);
    // Nothing was applied and nothing was disturbed — main is exactly where its own commit left it.
    expect(await sh(work, "status", "--porcelain")).toBe("");
    // The tip advances regardless: without it every later land re-offers this same delta forever.
    expect(result.repos[0]?.landedTip).toBe(await sh(conversation.cwd, "rev-parse", "HEAD"));
});

/* The other road work reaches main without landing: the BRANCH ITSELF gets merged — an agent told to "land
 * on main" runs the merge with its own git, or the user merges the branch by hand. Ancestry then says
 * everything is merged (the merge-base IS the tip), so land rightly applies nothing — but it must still SAY
 * SO: with landedTip left behind, the review counts every file as "not landed" forever, Land now stays armed
 * doing nothing, and a conflict report from before the merge never clears. */
test("work that reached main by merging the branch advances landedTip as a real outcome", async () => {
    const { work, worktrees, conversation } = await setup();
    const recorded = entryFor(conversation.repos);
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
    // Nothing was applied and nothing was disturbed — main is exactly where its merge commit left it.
    expect(await sh(work, "status", "--porcelain")).toBe("");

    // With the tip recorded, the NEXT land is the true no-op: no frame, no status flip.
    const again = await landAgent(worktrees, entryFor(result.repos));
    expect(again.changed).toBe(false);
});

test("a delta half-landed by hand lands its remainder, and reports no conflict for the half already there", async () => {
    const { work, worktrees, conversation } = await setup();
    const recorded = entryFor(conversation.repos);
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
    // The main line moved on and committed, so the workspace is clean — which is what lets git merge at all.
    await writeFile(join(work, "app.ts"), "line one MAIN\nline two\nline three\n");
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "main moved");

    const result = await landAgent(worktrees, entryFor(conversation.repos), "merge");

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

    const result = await landAgent(worktrees, entryFor(conversation.repos), "merge");

    // `--3way` goes through the index and refuses on an unstaged path, applying NOTHING — so the honest
    // outcome is the same report `check` gives, and the user commits or stashes their copy first.
    expect(result.resolving).toBeUndefined();
    expect(result.conflicts).toEqual([{ repo: "root", paths: [{ path: "app.ts", reason: "workspace" }], clean: 0 }]);
    expect(await readFile(join(work, "app.ts"), "utf8")).toBe("line one USER\nline two\nline three\n");
});

test("a user edit ELSEWHERE in the same file still lands (patch context, not path sets)", async () => {
    const { work, worktrees } = await setup();
    // Far enough apart that the hunks' ±3 context lines never overlap (a 3-line file would make any
    // same-file edit a context collision — that's the conflict test, not this one).
    const lines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
    const body = (edits: Record<number, string>): string => `${lines.map((line, index) => edits[index + 1] ?? line).join("\n")}\n`;
    await writeFile(join(work, "app.ts"), body({}));
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "long file");
    const grown = await worktrees.ensure("c2", []);
    await writeFile(join(grown.cwd, "app.ts"), body({ 1: "line 1 AGENT" }));
    await writeFile(join(work, "app.ts"), body({ 12: "line 12 USER" }));

    const result = await landAgent(worktrees, { ...entryFor(grown.repos), id: "c2", branch: "agent/c2" });
    expect(result.landed).toBe(true);
    expect(await readFile(join(work, "app.ts"), "utf8")).toBe(body({ 1: "line 1 AGENT", 12: "line 12 USER" }));
});

test("a delta living only in a NESTED repo lands — root has nothing it can stage, and says so quietly", async () => {
    const { work, worktrees } = await setup();
    // A workspace repo cloned under /work: the root repo tracks it as a gitlink, so root's view of the agent's
    // work is "modified: inner (modified content)" — dirt `git add -A` can stage nothing for, because a
    // gitlink moves only when the nested repo's own HEAD does. Root is landed FIRST (the composition is
    // ["root", ...discovered]), so committing on that verdict used to abort the whole land with git's "no
    // changes added to commit" — a 500 on POST /agents/{id}/land, with the agent's work stranded.
    const inner = join(work, "inner");
    await mkdir(inner, { recursive: true });
    await writeFile(join(inner, "lib.ts"), "inner one\ninner two\n");
    await sh(inner, "init", "-q", "--initial-branch=main");
    await sh(inner, "add", "-A");
    await sh(inner, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "inner baseline");
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "add inner");

    const conversation = await worktrees.ensure("c2", []);
    expect(conversation.repos.map(({ repo }) => repo)).toEqual(["root", "inner"]);
    await writeFile(join(worktrees.worktreeDir("c2", "inner"), "lib.ts"), "inner one EDITED\ninner two\n");

    const result = await landAgent(worktrees, { ...entryFor(conversation.repos), id: "c2", branch: "agent/c2" });
    expect(result.landed).toBe(true);
    expect(result.conflicts).toBeUndefined();
    expect(await readFile(join(inner, "lib.ts"), "utf8")).toBe("inner one EDITED\ninner two\n");
    // Root landed nothing and claims nothing: its worktree branch never moved, so landedTip stays unset.
    expect(result.repos.find((repo) => repo.repo === "root")?.landedTip).toBeUndefined();
    expect(result.repos.find((repo) => repo.repo === "inner")?.landedTip).toBe(await sh(worktrees.worktreeDir("c2", "inner"), "rev-parse", "HEAD"));
});

/* A RETIRED checkout (an archived agent, or a restored one whose next turn hasn't re-attached it yet) is not
 * "nothing to land": retire commits the worktree's remainder onto agent/<id>, so the branch holds everything
 * and the shared object store makes it readable from the main repo. Skipping the repo — the old behavior —
 * returned landed:true having landed NOTHING, which stamped the card Landed over a review still counting
 * every file as pending, with Land now armed and useless. */
test("a retired checkout still lands: the branch answers for the missing worktree", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), "line one EDITED\nline two\nline three\n");
    await writeFile(join(conversation.cwd, "added.ts"), "new file\n");
    await worktrees.retire("c1", conversation.repos, "fix the thing");
    expect(existsSync(worktrees.worktreeDir("c1", "root"))).toBe(false);

    const result = await landAgent(worktrees, entryFor(conversation.repos));

    expect(result.landed).toBe(true);
    expect(result.changed).toBe(true);
    expect(await readFile(join(work, "app.ts"), "utf8")).toBe("line one EDITED\nline two\nline three\n");
    expect(await readFile(join(work, "added.ts"), "utf8")).toBe("new file\n");
    // The cumulative diffstat still reports — the card's numbers survive the retired checkout.
    expect(result.diff.files).toBe(2);
    // landedTip reached the branch tip, so the review stops counting these files as pending.
    expect(result.repos.find((repo) => repo.repo === "root")?.landedTip).toBe(await sh(work, "rev-parse", "agent/c1"));
});

test("a retired checkout with everything landed is a no-op that still reports the cumulative output", async () => {
    const { worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), "line one EDITED\nline two\nline three\n");
    const first = await landAgent(worktrees, entryFor(conversation.repos));
    await worktrees.retire("c1", conversation.repos, "fix the thing");

    const again = await landAgent(worktrees, entryFor(first.repos));

    // changed:false keeps the frame and status flip away; diff.files>0 is what lets the caller keep the
    // settled status at "landed" rather than downgrading to idle.
    expect(again).toMatchObject({ landed: true, changed: false });
    expect(again.diff.files).toBe(1);
});

test("a discard fired during an in-flight land queues behind the repo lock — land finishes first", async () => {
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

    const landing = landAgent(worktrees, entryFor(conversation.repos), "check", pausingGit);
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
    // patch is EMPTY — `git apply` rejects an empty patch, so without the net-zero branch this range would
    // re-report a conflict (with no paths to resolve) on every future land, forever.
    await writeFile(join(conversation.cwd, "app.ts"), "line one EDITED\nline two\nline three\n");
    await sh(conversation.cwd, "add", "-A");
    await sh(conversation.cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "edit");
    await writeFile(join(conversation.cwd, "app.ts"), "line one\nline two\nline three\n");

    const result = await landAgent(worktrees, entryFor(conversation.repos));
    expect(result.landed).toBe(true);
    expect(result.conflicts).toBeUndefined();
    expect(await sh(work, "status", "--porcelain")).toBe("");
    // landedTip advanced past the reverted range…
    expect(result.repos.find((repo) => repo.repo === "root")?.landedTip).toBe(await sh(conversation.cwd, "rev-parse", "HEAD"));
    // …so the next land is a clean no-op (no frame, no status flip), not a replay.
    const again = await landAgent(worktrees, entryFor(result.repos));
    expect(again).toMatchObject({ landed: true, changed: false });
});

/* MEASURE MODE — auto-land off. Everything a land does except touching the main tree: the provenance commit,
 * the diffstat and the already-in-main bookkeeping all run, and the outstanding delta is reported `held`
 * rather than applied — the caller stamps the card "Ready to land" on it. */
test("measure holds the delta on the branch: nothing applies, tips stay, the diffstat still reports", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), "line one EDITED\nline two\nline three\n");
    await writeFile(join(conversation.cwd, "added.ts"), "new file\n");

    const result = await landAgent(worktrees, entryFor(conversation.repos), "measure");

    // A real outcome (the caller persists and flips status on it), but not a landed one and not a refusal.
    expect(result).toMatchObject({ landed: false, changed: true, held: true });
    expect(result.conflicts).toBeUndefined();
    // The main tree is byte-identical — the whole point of holding.
    expect(await readFile(join(work, "app.ts"), "utf8")).toBe("line one\nline two\nline three\n");
    expect(existsSync(join(work, "added.ts"))).toBe(false);
    expect(await sh(work, "status", "--porcelain")).toBe("");
    // The card's numbers stay as current as a landed agent's.
    expect(result.diff).toEqual({ files: 2, insertions: 2, deletions: 1 });
    // landedTip did NOT advance — the eventual deliberate land carries this exact delta…
    expect(result.repos.find((repo) => repo.repo === "root")?.landedTip).toBeUndefined();
    // …and the provenance commit happened: the worktree's dirty state is safe on agent/c1.
    expect(await sh(conversation.cwd, "status", "--porcelain")).toBe("");

    // The deliberate land is an ordinary check land of the cumulative delta.
    const landed = await landAgent(worktrees, entryFor(result.repos));
    expect(landed.landed).toBe(true);
    expect(landed.held).toBeUndefined();
    expect(await readFile(join(work, "app.ts"), "utf8")).toBe("line one EDITED\nline two\nline three\n");
    expect(await readFile(join(work, "added.ts"), "utf8")).toBe("new file\n");
});

test("measure still recognizes work that reached main by another road, instead of holding it forever", async () => {
    const { work, worktrees, conversation } = await setup();
    const recorded = entryFor(conversation.repos);
    await writeFile(join(conversation.cwd, "agent.ts"), "agent work\n");
    await sh(conversation.cwd, "add", "-A");
    await sh(conversation.cwd, "-c", "user.name=a", "-c", "user.email=a@a", "commit", "-q", "-m", "agent");
    // The same content reaches main as its OWN commit — a held card offering to land this could never do
    // anything, which is the dead end the reverse probe exists to rule out.
    await writeFile(join(work, "agent.ts"), "agent work\n");
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "the same work, by hand");

    const result = await landAgent(worktrees, entryFor(recorded.repos), "measure");

    expect(result.held).toBeUndefined();
    expect(result).toMatchObject({ landed: true, changed: true });
    expect(result.repos[0]?.landedTip).toBe(await sh(conversation.cwd, "rev-parse", "HEAD"));
    expect(await sh(work, "status", "--porcelain")).toBe("");
});

test("measure with nothing to measure stays changed:false, like any other no-op land", async () => {
    const { worktrees, conversation } = await setup();
    const result = await landAgent(worktrees, entryFor(conversation.repos), "measure");
    expect(result).toMatchObject({ landed: true, changed: false });
    expect(result.held).toBeUndefined();
});

test("deletes and renames land; a conflicted land keeps landedTip so recovery applies the same delta", async () => {
    const { work, worktrees, conversation } = await setup();
    await sh(conversation.cwd, "mv", "app.ts", "renamed.ts");
    await sh(conversation.cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "rename");

    const result = await landAgent(worktrees, entryFor(conversation.repos));
    expect(result.landed).toBe(true);
    expect(existsSync(join(work, "app.ts"))).toBe(false);
    expect(await readFile(join(work, "renamed.ts"), "utf8")).toBe("line one\nline two\nline three\n");

    // Conflict a follow-up: agent edits renamed.ts, user edits the main copy on the same line.
    await writeFile(join(conversation.cwd, "renamed.ts"), "line one AGENT\nline two\nline three\n");
    await writeFile(join(work, "renamed.ts"), "line one USER\nline two\nline three\n");
    const conflicted = await landAgent(worktrees, entryFor(result.repos));
    expect(conflicted.landed).toBe(false);
    // landedTip did NOT advance for the conflicted repo — Land now retries the exact same delta.
    expect(conflicted.repos.find((repo) => repo.repo === "root")?.landedTip).toBe(result.repos.find((repo) => repo.repo === "root")?.landedTip);
    // User resolves (reverts their edit) → recovery lands the pending delta.
    await writeFile(join(work, "renamed.ts"), "line one\nline two\nline three\n");
    const recovered = await landAgent(worktrees, entryFor(conflicted.repos));
    expect(recovered.landed).toBe(true);
    expect(await readFile(join(work, "renamed.ts"), "utf8")).toBe("line one AGENT\nline two\nline three\n");
});

/* THE RENAME THAT LANDED HALF-APPLIED. Whole-delta landing has always carried renames correctly (the test
 * above); the SUBSET land did not, and the two only meet when part of a delta is already in the main tree — a
 * combination nothing covered, which is how this shipped.
 *
 * The mechanism, in one line: the subset was described by PATHS, and `git diff --name-only` names a rename at
 * its destination and nowhere else, so the pathspec built from it could no longer express the rename. `-M` had
 * nothing to pair, emitted a bare creation, and the apply wrote the new file while leaving the old one in the
 * tree. The user's commit then recorded the stale copy as still-present, and it surfaced later as a deletion
 * with no author. See land.ts DeltaChange. */
test("a rename landing as part of a half-landed delta leaves no stale source behind", async () => {
    const { work, worktrees, conversation } = await setup();
    const recorded = entryFor(conversation.repos);
    await sh(conversation.cwd, "mv", "app.ts", "moved.ts");
    await writeFile(join(conversation.cwd, "already.ts"), "already on main\n");
    await sh(conversation.cwd, "add", "-A");
    await sh(conversation.cwd, "-c", "user.name=a", "-c", "user.email=a@a", "commit", "-q", "-m", "rename plus a file");
    // Half of the delta reached main by another road, so the whole patch can no longer apply atomically and the
    // land falls back to carrying only the outstanding remainder — here, the rename.
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

// The same subset land carrying an outright DELETION — the other change whose whole content is the removal of a
// path, and so the other one a pathspec-built patch can silently decline to express.
test("a deletion landing as part of a half-landed delta removes the file", async () => {
    const { work, worktrees } = await setup();
    await writeFile(join(work, "doomed.ts"), "delete me\n");
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "a file to delete");
    // A checkout taken AFTER that commit, so the branch has the file to delete — setup()'s own predates it.
    const conversation = await worktrees.ensure("c2", []);
    const recorded = { ...entryFor(conversation.repos), id: "c2", branch: "agent/c2" };
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
 * file creation, and a creation applies against any tree whatsoever — so the user's conflicting edit to the
 * SOURCE was invisible to the probe and the change got called clean. The probe now spans both legs, which is
 * what lets the pre-image hunks meet the user's copy and refuse.
 *
 * (A 100%-similarity rename is a different case and not a conflict: it carries no hunks, so git renames the
 * user's content to the new path and nothing is lost — which is what `git mv` on a dirty file does too.) */
test("a user edit under a rename-with-edits is a conflict, not a clean change", async () => {
    const { work, worktrees, conversation } = await setup();
    await sh(conversation.cwd, "mv", "app.ts", "moved.ts");
    await writeFile(join(conversation.cwd, "moved.ts"), "line one AGENT\nline two\nline three\n");
    await sh(conversation.cwd, "add", "-A");
    await sh(conversation.cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "rename and edit");
    await writeFile(join(work, "app.ts"), "line one USER\nline two\nline three\n");

    const result = await landAgent(worktrees, entryFor(conversation.repos));

    expect(result.landed).toBe(false);
    // Reported at the destination — the path the user will go looking for — with their own copy as the cause.
    expect(result.conflicts).toEqual([{ repo: "root", paths: [{ path: "moved.ts", reason: "workspace" }], clean: 0 }]);
    // `check` promises a refusal changes nothing: the user's edit stands and no half-rename was written.
    expect(await readFile(join(work, "app.ts"), "utf8")).toBe("line one USER\nline two\nline three\n");
    expect(existsSync(join(work, "moved.ts"))).toBe(false);
});

/* The review's span, measured the way the diff route now measures it (agents.routes.ts → anchorOf without
 * the landedTip rung). The bug this pins down: an agent whose worktree fast-forwarded onto newer main
 * commits reviewed everything main gained in between as ITS OWN output — one real card showed a hundred
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
    const first = await landAgent(worktrees, entryFor(fresh.repos));
    expect(first.landed).toBe(true);
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "commit landed work");
    // Main also gains someone else's edit at the bottom of the same file.
    await writeFile(join(work, "long.ts"), lines([0, "one AGENT"], [6, "seven OTHERS"]));
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "someone else");
    // The agent syncs (merge main into its branch) and keeps working — an edit whose hunk CONTEXT reaches
    // the line someone else changed, which is what made the stale-anchored patch unapplicable.
    await sh(fresh.cwd, "-c", "user.name=t", "-c", "user.email=t@t", "merge", "-q", "-m", "sync", await sh(work, "rev-parse", "HEAD"));
    await writeFile(join(fresh.cwd, "long.ts"), lines([0, "one AGENT"], [6, "seven OTHERS"], [3, "four AGAIN"]));

    const second = await landAgent(worktrees, entryFor(first.repos));
    // Without the merge-base rung superseding landedTip this reported a conflict on long.ts.
    expect(second.landed).toBe(true);
    expect(second.conflicts).toBeUndefined();
    expect(await readFile(join(work, "long.ts"), "utf8")).toBe(lines([0, "one AGENT"], [6, "seven OTHERS"], [3, "four AGAIN"]));
});
