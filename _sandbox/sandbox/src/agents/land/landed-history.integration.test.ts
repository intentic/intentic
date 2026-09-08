import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { headSha } from "../../git/changes/changes.js";
import { ensureRootRepo } from "../../git/remote/root-repo.js";
import { createLogger } from "../../logger.js";
import { createPerfTracker } from "../../platform/resources/perf.js";
import { isolatedAgent, noIsolation } from "../../testing.js";
import { workspacePaths } from "../../workspace/workspace.js";
import { agentRepoReview, presentInMain } from "./agent-changes.js";
import { landAgent } from "./land.js";
import { commitsCarrying, historySpanStart } from "./landed-history.js";
import { createAgentWorktrees, type AgentWorktrees, type ConversationWorktree } from "../worktrees/worktrees.js";

// Against real git: every fact this module reads lives in a commit graph, not a stub that would only agree with itself.

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
    const base = await mkdtemp(join(tmpdir(), "intentic-landed-history-"));
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

// Same reading agentRepoReview -> presentInMain, not hand-picked paths: 'absorbed' is exactly the input this module's
// soundness rests on.
const placed = async (
    work: string,
    worktrees: AgentWorktrees,
    entry: ReturnType<typeof isolatedAgent>,
): Promise<{ subject: string; paths: string[] }[]> => {
    const composed = entry.repos[0];
    if (composed === undefined) {
        throw new Error("no repo in the composition");
    }
    const changes = await agentRepoReview(worktrees, entry, composed);
    const present = await presentInMain(
        worktrees,
        entry,
        composed,
        changes.map((change) => change.path),
    );
    const absorbed = changes.map((change) => change.path).filter((path) => present.absorbed.has(path));
    const head = await headSha(work);
    if (head === undefined) {
        throw new Error("main has no head");
    }
    const landedHead = composed.landedHead;
    // Same fallback ladder the route walks: the recorded head while still on the main line, else the merge-base anchor.
    const from =
        (landedHead === undefined ? undefined : await historySpanStart(work, landedHead, head)) ?? (await sh(work, "merge-base", head, entry.branch));
    const carried = await commitsCarrying(work, from, head, absorbed);
    return carried.map((commitOf) => ({ subject: commitOf.subject, paths: [...commitOf.paths].sort() }));
};

test("the commit the user took a landing in is the one it is found under", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), edited(1));
    // Untracked add beside a tracked edit: an uncommitted new file is in no commit, so a sha-only span would lose it.
    await writeFile(join(conversation.cwd, "added.ts"), "new file\n");
    const landed = await landAgent(worktrees, isolatedAgent(conversation.repos));

    await sh(work, "add", "-A");
    await commit(work, "take the agent's work");

    expect(await placed(work, worktrees, isolatedAgent(landed.repos))).toEqual([{ subject: "take the agent's work", paths: ["added.ts", "app.ts"] }]);
});

test("work committed in two sittings comes back as two commits, each holding only its own files", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), edited(1));
    await writeFile(join(conversation.cwd, "other.ts"), edited(2));
    const landed = await landAgent(worktrees, isolatedAgent(conversation.repos));

    await sh(work, "add", "-A", "--", "app.ts");
    await commit(work, "first: app");
    await sh(work, "add", "-A", "--", "other.ts");
    await commit(work, "second: other");

    expect(await placed(work, worktrees, isolatedAgent(landed.repos))).toEqual([
        { subject: "second: other", paths: ["other.ts"] },
        { subject: "first: app", paths: ["app.ts"] },
    ]);
});

test("a file history touched again is attributed to the newest commit that left the agent's content", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), edited(1));
    const landed = await landAgent(worktrees, isolatedAgent(conversation.repos));

    await sh(work, "add", "-A");
    await commit(work, "take it");
    // Away and back: three commits name this file, but only the last leaves content worth reading.
    await writeFile(join(work, "app.ts"), `${edited(1)}scratch\n`);
    await sh(work, "add", "-A");
    await commit(work, "an unrelated edit on top");
    await writeFile(join(work, "app.ts"), edited(1));
    await sh(work, "add", "-A");
    await commit(work, "put it back");

    expect(await placed(work, worktrees, isolatedAgent(landed.repos))).toEqual([{ subject: "put it back", paths: ["app.ts"] }]);
});

test("a landing absorbed through a merge is found at the merge, not lost with it", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), edited(1));
    const landed = await landAgent(worktrees, isolatedAgent(conversation.repos));

    // `git log` shows no diff for a merge by default; without --diff-merges=first-parent this lands unattributable.
    const main = await sh(work, "rev-parse", "--abbrev-ref", "HEAD");
    await sh(work, "checkout", "-q", "-b", "user-side");
    await sh(work, "add", "-A");
    await commit(work, "user takes it on a side branch");
    await sh(work, "checkout", "-q", main);
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "merge", "-q", "--no-ff", "user-side", "-m", "merge the side branch");

    const found = await placed(work, worktrees, isolatedAgent(landed.repos));
    expect(found[0]).toEqual({ subject: "merge the side branch", paths: ["app.ts"] });
});

test("a main line rewritten under the landing falls back to the newest commit both still agree on", async () => {
    const { work, worktrees, conversation } = await setup();
    // A commit before the land gives the rewrite below something to reset behind the landing.
    await writeFile(join(work, "notes.md"), "before the agent\n");
    await sh(work, "add", "-A");
    await commit(work, "the user's own commit");
    await writeFile(join(conversation.cwd, "app.ts"), edited(1));
    await landAgent(worktrees, isolatedAgent(conversation.repos));

    const landedHead = await headSha(work);
    if (landedHead === undefined) {
        throw new Error("main has no head");
    }
    // Ordinary case: the recorded head is still on the main line, so it stays the span's start unchanged.
    await sh(work, "add", "-A");
    await commit(work, "take it");
    const takenHead = await headSha(work);
    expect(await historySpanStart(work, landedHead, takenHead!)).toBe(landedHead);

    // An amend/rebase/reset makes the recorded head unreachable; the merge-base is the tightest span still ours.
    await sh(work, "reset", "-q", "--hard", `${landedHead}~1`);
    await writeFile(join(work, "unrelated.ts"), "rewritten\n");
    await sh(work, "add", "-A");
    await commit(work, "a different history");
    const rewritten = await headSha(work);
    const fallback = await historySpanStart(work, landedHead, rewritten!);
    expect(fallback).toBe(await sh(work, "merge-base", landedHead, rewritten!));
    expect(fallback).not.toBe(landedHead);
});

test("nothing to place costs no git at all", async () => {
    const { work } = await setup();
    expect(await commitsCarrying(work, "HEAD", "HEAD", [], () => Promise.reject(new Error("git must not run")))).toEqual([]);
});
