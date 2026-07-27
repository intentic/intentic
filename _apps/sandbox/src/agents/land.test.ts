import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { defaultGit } from "@intentic/scaffold";
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
    await writeFile(join(work, "app.ts"), "line one\nline two\nline three\n");
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "baseline");
    const worktrees = createAgentWorktrees({ workspace, worktreesRoot: join(historyRoot, "worktrees"), logger });
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
    expect(result.conflicts).toEqual([{ repo: "root", paths: ["app.ts"] }]);
    expect(await readFile(join(work, "app.ts"), "utf8")).toBe("line one USER\nline two\nline three\n");
    // The agent's work is intact in the worktree for Land-now recovery.
    expect(await readFile(join(conversation.cwd, "app.ts"), "utf8")).toBe("line one AGENT\nline two\nline three\n");
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

    const landing = landAgent(worktrees, entryFor(conversation.repos), pausingGit);
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
