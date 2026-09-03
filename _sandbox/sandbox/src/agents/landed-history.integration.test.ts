import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { headSha } from "../git/changes.js";
import { ensureRootRepo } from "../git/root-repo.js";
import { createLogger } from "../logger.js";
import { createPerfTracker } from "../platform/perf.js";
import { isolatedAgent, noIsolation } from "../testing.js";
import { workspacePaths } from "../workspace/workspace.js";
import { agentRepoReview, presentInMain } from "./agent-changes.js";
import { landAgent } from "./land.js";
import { commitsCarrying, historySpanStart } from "./landed-history.js";
import { createAgentWorktrees, type AgentWorktrees, type ConversationWorktree } from "./worktrees.js";

/* WHERE A LANDING ENDED UP ONCE THE USER COMMITTED IT, against real git, because every fact this module reads
 * is one that lives in a commit graph and nowhere else. The span it measures over is pinned by a sha the land
 * recorded, the attribution rule is "the newest commit that left this content", and both are claims about what
 * `git log` actually answers over a real history: stub it and the test proves the stub agrees with itself.
 *
 * This is the dead end in test form. Committing an agent's work retires its rows (agent-changes.integration
 * proves that reading, and it is the right one), which left the review with nothing to show and one sentence
 * saying the work was "in your workspace's history" over an empty panel. It always WAS findable. */

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

/* The route's own two steps, in one call: read the review, keep the half history has taken, and ask where it
 * went. Deliberately the SAME reading the review takes (agentRepoReview → presentInMain) rather than a set of
 * paths written out by hand, because "absorbed" is exactly the input this module's soundness argument rests
 * on: it is the set whose committed content already equals the branch's. */
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
    // Exactly the fallback ladder the route walks: the recorded head while it is still on the main line, and
    // the merge-base anchor for a landing that recorded none (see the route's own note).
    const from =
        (landedHead === undefined ? undefined : await historySpanStart(work, landedHead, head)) ?? (await sh(work, "merge-base", head, entry.branch));
    const carried = await commitsCarrying(work, from, head, absorbed);
    return carried.map((commitOf) => ({ subject: commitOf.subject, paths: [...commitOf.paths].sort() }));
};

test("the commit the user took a landing in is the one it is found under", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), edited(1));
    // An untracked add beside a tracked edit: a landed-but-uncommitted new file is in no commit and no index,
    // so it is the path a span read off shas alone loses, and it has to come back with the rest.
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

    // Newest first, and the two sets are disjoint: a file belongs to exactly one commit, which is what lets a
    // panel add these counts up without over-counting anything history touched twice.
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
    // Away and back: the file is still absorbed at the end (its content equals the branch's again), and THREE
    // commits in the span name it. Only the last one left the content a reader would be sent to read, so
    // naming the first would send them to a commit whose result no longer exists anywhere.
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

    /* The user takes the landing on a branch of their own and merges it back with a merge commit. `git log`
     * shows NO diff for a merge by default, so without --diff-merges=first-parent this landing reports as
     * absorbed and unattributable at once: the panel would say the work is in history and name nothing. */
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
    // A commit of the user's own BEFORE the land, so the rewrite below has somewhere behind the landing to
    // reset to. Without it the landing sits on the root commit and there is no divergence to construct.
    await writeFile(join(work, "notes.md"), "before the agent\n");
    await sh(work, "add", "-A");
    await commit(work, "the user's own commit");
    await writeFile(join(conversation.cwd, "app.ts"), edited(1));
    await landAgent(worktrees, isolatedAgent(conversation.repos));

    const landedHead = await headSha(work);
    if (landedHead === undefined) {
        throw new Error("main has no head");
    }
    // While the recorded head is still on the main line it is the span's start, unchanged: the tightest span
    // there is, and the ordinary case.
    await sh(work, "add", "-A");
    await commit(work, "take it");
    const takenHead = await headSha(work);
    expect(await historySpanStart(work, landedHead, takenHead!)).toBe(landedHead);

    /* Now the user rewrites their own history behind the land, an amend, a rebase, a reset: all ordinary
     * things to do between committing an agent's work and coming back to look at it. The recorded head is no
     * longer reachable, so a span measured from it would range over both sides of the divergence and name
     * commits that were never in this history. The merge-base is the tightest span that is certainly ours. */
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
    // The overwhelmingly common call: a conversation whose work is still a difference has no absorbed paths,
    // and the guard is what keeps the panel's read free in that case rather than a spawn that returns nothing.
    expect(await commitsCarrying(work, "HEAD", "HEAD", [], () => Promise.reject(new Error("git must not run")))).toEqual([]);
});
