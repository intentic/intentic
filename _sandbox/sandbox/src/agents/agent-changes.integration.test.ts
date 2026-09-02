import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { discardPaths } from "../git/changes.js";
import { ensureRootRepo } from "../git/root-repo.js";
import { createLogger } from "../logger.js";
import { createPerfTracker } from "../platform/perf.js";
import { isolatedAgent, noIsolation } from "../testing.js";
import { workspacePaths } from "../workspace/workspace.js";
import { agentRepoReview, presentInMain } from "./agent-changes.js";
import { landAgent } from "./land.js";
import { createAgentWorktrees, type AgentWorktrees, type ConversationWorktree } from "./worktrees.js";

/* WHAT THE REVIEW SHOWS AFTER THE USER HAS DEALT WITH A LANDING, against real git, because every case here is
 * one that NO SHA RECORDS. A land leaves its delta in the main tree uncommitted; accepting it moves main's
 * HEAD and nothing else, discarding it moves nothing at all, and the agent's branch is untouched by either.
 * Stub any of it and the test proves only that the stub agrees with itself.
 *
 * This is the reported bug in test form: land, then accept some and discard some, and the review kept showing
 * every file as though nothing had happened. Its anchor was the merge-base, which a commit on main does not
 * move, and its `landed` flag came from `landedTip`, which a discard does not move either. */

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
const commit = (cwd: string, message: string): Promise<string> => sh(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message);
const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });
const perf = createPerfTracker(logger);

const LINES = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
const edited = (line: number): string => `${LINES.map((text, index) => (index === line - 1 ? `${text} EDITED` : text)).join("\n")}\n`;

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

const setup = async (): Promise<{ work: string; worktrees: AgentWorktrees; conversation: ConversationWorktree }> => {
    const base = await mkdtemp(join(tmpdir(), "intentic-present-"));
    tempDirs.push(base);
    const work = join(base, "work");
    const historyRoot = join(base, "history");
    const workspace = workspacePaths(work);
    await mkdir(work, { recursive: true });
    await ensureRootRepo(workspace, historyRoot);
    await writeFile(join(work, "app.ts"), `${LINES.join("\n")}\n`);
    await writeFile(join(work, "other.ts"), `${LINES.join("\n")}\n`);
    await sh(work, "add", "-A");
    await commit(work, "baseline");
    const worktrees = createAgentWorktrees({
        workspace,
        worktreesRoot: join(historyRoot, "worktrees"),
        historyRoot,
        isolation: noIsolation(work, historyRoot),
        logger,
        perf,
    });
    return { work, worktrees, conversation: await worktrees.ensure("c1", []) };
};

// The review's own two steps, in one call: the rows, and how each of them stands against the main tree.
const review = async (
    worktrees: AgentWorktrees,
    entry: ReturnType<typeof isolatedAgent>,
): Promise<{ rows: string[]; landed: string[]; absorbed: string[] }> => {
    const composed = entry.repos[0];
    if (composed === undefined) {
        throw new Error("no repo in the composition");
    }
    const changes = await agentRepoReview(worktrees, entry, composed);
    const paths = changes.map((change) => change.path);
    const present = await presentInMain(worktrees, entry, composed, paths);
    return {
        rows: paths.filter((path) => !present.absorbed.has(path)).sort(),
        landed: paths.filter((path) => !present.absorbed.has(path) && present.inWorkspace.has(path)).sort(),
        absorbed: [...present.absorbed].sort(),
    };
};

test("landed and left uncommitted: every row stays, and every row says the workspace has it", async () => {
    const { worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), edited(1));
    // An untracked add beside a tracked edit: the new file is the case `git diff` cannot see at all, since it
    // walks the commit and the index and a landed-but-uncommitted file is in neither.
    await writeFile(join(conversation.cwd, "added.ts"), "new file\n");
    const landed = await landAgent(worktrees, isolatedAgent(conversation.repos));

    const state = await review(worktrees, isolatedAgent(landed.repos));
    expect(state.rows).toEqual(["added.ts", "app.ts"]);
    expect(state.landed).toEqual(["added.ts", "app.ts"]);
    expect(state.absorbed).toEqual([]);
});

test("accepting the landed work retires its rows: they are the user's history now, not a difference", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), edited(1));
    await writeFile(join(conversation.cwd, "added.ts"), "new file\n");
    const landed = await landAgent(worktrees, isolatedAgent(conversation.repos));

    await sh(work, "add", "-A");
    await commit(work, "take it");

    const state = await review(worktrees, isolatedAgent(landed.repos));
    // The whole of the old bug: main's HEAD moved, the merge-base did not, so both rows survived here as
    // "changed" against a fork point from before the land, and both claimed to be landed.
    expect(state.rows).toEqual([]);
    expect(state.absorbed).toEqual(["added.ts", "app.ts"]);
});

test("discarding the landed work puts its rows back as outstanding, which no sha can say", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), edited(1));
    await writeFile(join(conversation.cwd, "added.ts"), "new file\n");
    const landed = await landAgent(worktrees, isolatedAgent(conversation.repos));

    await discardPaths(work, undefined);

    const state = await review(worktrees, isolatedAgent(landed.repos));
    expect(state.rows).toEqual(["added.ts", "app.ts"]);
    // Not in the workspace any more, which is what puts them back under "Land now". The old reading answered
    // from `landedTip`, which the discard left exactly where it was, so both rows kept saying "landed".
    expect(state.landed).toEqual([]);
    expect(state.absorbed).toEqual([]);
});

test("accept one, discard the other: the review tells the two apart", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), edited(1));
    await writeFile(join(conversation.cwd, "other.ts"), edited(2));
    const landed = await landAgent(worktrees, isolatedAgent(conversation.repos));

    await sh(work, "add", "-A", "--", "app.ts");
    await commit(work, "keep app.ts");
    await discardPaths(work, ["other.ts"]);

    const state = await review(worktrees, isolatedAgent(landed.repos));
    expect(state.rows).toEqual(["other.ts"]);
    expect(state.landed).toEqual([]);
    expect(state.absorbed).toEqual(["app.ts"]);
});

test("a landed file the agent has since rewritten is outstanding again, name in the tree or not", async () => {
    const { worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "added.ts"), "first draft\n");
    const landed = await landAgent(worktrees, isolatedAgent(conversation.repos));

    // Turn two rewrites the same new file and does NOT land. A file of that name is sitting untracked in the
    // main tree, so presence by NAME would call this landed; it is the content that answers.
    await writeFile(join(conversation.cwd, "added.ts"), "second draft\n");
    const entry = isolatedAgent(landed.repos);
    await sh(conversation.cwd, "add", "-A");
    await commit(conversation.cwd, "turn two");

    const state = await review(worktrees, entry);
    expect(state.rows).toEqual(["added.ts"]);
    expect(state.landed).toEqual([]);
    expect(state.absorbed).toEqual([]);
});

test("work the agent has not committed yet is never read as landed, whatever the branch says", async () => {
    const { worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), edited(1));
    const landed = await landAgent(worktrees, isolatedAgent(conversation.repos));

    // Mid-turn: on disk in the agent's checkout and in no commit, so the branch tip speaks for none of it.
    await writeFile(join(conversation.cwd, "app.ts"), edited(4));
    await writeFile(join(conversation.cwd, "draft.ts"), "half a thought\n");

    const state = await review(worktrees, isolatedAgent(landed.repos));
    expect(state.rows).toEqual(["app.ts", "draft.ts"]);
    expect(state.landed).toEqual([]);
    expect(state.absorbed).toEqual([]);
});

test("a branch git cannot read hides nothing: every row stays, and none of them claims to be in the tree", async () => {
    const { worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), edited(1));
    const landed = await landAgent(worktrees, isolatedAgent(conversation.repos));
    const entry = isolatedAgent(landed.repos);

    // A pruned branch, a rewritten history, a main checkout that has gone: the probe's reads throw, and the
    // one thing it must not do then is answer as though it had looked. Rows shown, none flagged: a "Land now"
    // over content already there is a no-op, work the user cannot see is missing is not.
    const present = await presentInMain(worktrees, { ...entry, branch: "agent/does-not-exist" }, entry.repos[0]!, ["app.ts"]);
    expect([...present.absorbed]).toEqual([]);
    expect([...present.inWorkspace]).toEqual([]);
});

test("a rebase after the accept leaves the answer where it was: nothing outstanding, nothing listed", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), edited(1));
    const landed = await landAgent(worktrees, isolatedAgent(conversation.repos));

    await sh(work, "add", "-A");
    await commit(work, "take it");
    // The pre-turn sync (agents/sync.ts) moves the branch onto the main line it was just merged into. The
    // review must not change its mind about a single file because of it.
    const head = await sh(work, "rev-parse", "HEAD");
    await sh(conversation.cwd, "rebase", "--onto", head, landed.repos[0]?.landedTip ?? "HEAD").catch(() => sh(conversation.cwd, "rebase", "--abort"));

    const state = await review(worktrees, isolatedAgent(landed.repos));
    expect(state.rows).toEqual([]);
});
