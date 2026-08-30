import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { ensureRootRepo } from "../git/root-repo.js";
import { createLogger } from "../logger.js";
import { createPerfTracker } from "../platform/perf.js";
import { noIsolation } from "../testing.js";
import { workspacePaths } from "../workspace/workspace.js";
import type { IsolatedAgent } from "./agents-store.js";
import { landAgent } from "./land.js";
import { syncBeforeLand, syncConversation } from "./sync.js";
import { createAgentWorktrees, type AgentWorktrees } from "./worktrees.js";

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
const commit = (cwd: string, message: string): Promise<string> => sh(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message);
const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });
const perf = createPerfTracker(logger);

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

// A workspace whose root repo holds two files, and one conversation branched off it. `app.ts` is the file both
// sides fight over; `other.ts` is what the main line moves without the agent noticing.
const setup = async (): Promise<{ work: string; worktree: string; worktrees: AgentWorktrees }> => {
    const base = await mkdtemp(join(tmpdir(), "intentic-sync-"));
    tempDirs.push(base);
    const work = join(base, "work");
    const historyRoot = join(base, "history");
    const workspace = workspacePaths(work);
    await mkdir(work, { recursive: true });
    await ensureRootRepo(workspace, historyRoot);
    await writeFile(join(work, "app.ts"), "one\ntwo\nthree\nfour\nfive\n");
    await writeFile(join(work, "other.ts"), "untouched\n");
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
    await worktrees.ensure("c1", []);
    return { work, worktree: worktrees.worktreeDir("c1", "root"), worktrees };
};

const sync = (worktrees: AgentWorktrees, landedTip?: string): ReturnType<typeof syncConversation> =>
    syncConversation(worktrees, "c1", [{ repo: "root", landedTip }], "fix the thing");

// The registry row the real land reads, so the tests below can produce `landedTip` the way a turn does rather
// than assert against a sha they wrote themselves.
const entryOf = (base: string, landedTip?: string): IsolatedAgent => ({
    id: "c1",
    branch: "agent/c1",
    title: "fix the thing",
    provider: "claude",
    harness: "native",
    repos: [{ repo: "root", base, ...(landedTip === undefined ? {} : { landedTip }) }],
    status: "idle",
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    createdAt: 0,
    updatedAt: 0,
});

// One turn's worth of work, committed on the branch the way land's provenance commit does.
const turn = async (worktree: string, write: () => Promise<void>): Promise<void> => {
    await write();
    await sh(worktree, "add", "-A");
    await commit(worktree, "agent work");
};

test("reports nothing when the branch already sits on the main line", async () => {
    const { worktrees } = await setup();
    expect(await sync(worktrees)).toEqual([]);
});

/* THE COLLISION A RENAME HIDES. `--name-only` reports a rename at its destination and nowhere else (git
 * detects renames by default: omitting `-M` does not turn that off), so main renaming a file the agent is
 * editing produced two path lists that could not intersect: `moved` named the destination, `mine` named the
 * source, and `overlap` came back empty. The turn preamble then told the agent main had moved underneath it
 * and named nothing: on the one file where its work was about to be replayed onto a path that no longer
 * exists. Same defect origins.ts carried on the attribution side. */
test("a main-line RENAME of a file the agent edited is reported as an overlap", async () => {
    const { work, worktree, worktrees } = await setup();
    await writeFile(join(worktree, "app.ts"), "one\ntwo\nthree\nfour\nAGENT\n");
    await sh(worktree, "add", "-A");
    await commit(worktree, "agent work");
    // Main moves the very file the agent is holding, verbatim: a 100% rename, the case that collapses.
    await sh(work, "mv", "app.ts", "renamed.ts");
    await commit(work, "user renamed it");

    const [root] = await sync(worktrees);
    // Both halves of the rename are what main did, and the source is where the agent's work sits.
    expect(root?.moved).toEqual(["app.ts", "renamed.ts"]);
    expect(root?.overlap).toEqual(["app.ts"]);
});

test("replays the agent's commits onto a main line that moved, and says what moved", async () => {
    const { work, worktree, worktrees } = await setup();
    // The agent edits the last line of app.ts and commits.
    await writeFile(join(worktree, "app.ts"), "one\ntwo\nthree\nfour\nAGENT\n");
    await sh(worktree, "add", "-A");
    await commit(worktree, "agent work");
    // The user, meanwhile, edits the FIRST line of the same file and adds a second commit elsewhere.
    await writeFile(join(work, "app.ts"), "USER\ntwo\nthree\nfour\nfive\n");
    await sh(work, "add", "-A");
    await commit(work, "user work");
    await writeFile(join(work, "other.ts"), "moved\n");
    await sh(work, "add", "-A");
    await commit(work, "unrelated");

    const [root] = await sync(worktrees);
    expect(root).toMatchObject({ repo: "root", commits: 2, moved: ["app.ts", "other.ts"], overlap: ["app.ts"] });
    expect(root?.blocked).toBeUndefined();
    expect(root?.onto).toBe(await sh(work, "rev-parse", "HEAD"));
    // Both sides survive: the user's first line and the agent's last one, in one file.
    expect(await readFile(join(worktree, "app.ts"), "utf8")).toBe("USER\ntwo\nthree\nfour\nAGENT\n");
    // And the branch really is on top of the main line now, not merely holding its content.
    expect(await sh(worktree, "rev-list", "--count", `${await sh(work, "rev-parse", "HEAD")}..HEAD`)).toBe("1");
});

test("commits the worktree's dirty remainder first: a rebase refuses to start otherwise", async () => {
    const { work, worktree, worktrees } = await setup();
    // An interrupted turn's leftovers: edited and never committed.
    await writeFile(join(worktree, "app.ts"), "one\ntwo\nthree\nfour\nAGENT\n");
    await writeFile(join(worktree, "new.ts"), "brand new\n");
    await writeFile(join(work, "other.ts"), "moved\n");
    await sh(work, "add", "-A");
    await commit(work, "user work");

    const [root] = await sync(worktrees);
    expect(root?.blocked).toBeUndefined();
    expect(await sh(worktree, "status", "--porcelain")).toBe("");
    expect(await readFile(join(worktree, "app.ts"), "utf8")).toBe("one\ntwo\nthree\nfour\nAGENT\n");
    expect(await readFile(join(worktree, "new.ts"), "utf8")).toBe("brand new\n");
    // The remainder is provenance, carrying the agent title and the daemon's identity: land's own commit.
    expect(await sh(worktree, "log", "-1", "--format=%s%n%an")).toBe("Agent: fix the thing\nintentic");
});

/* TWICE IN ONE TURN. The pass used to run once, at the turn's start; a turn that parks on a question or a plan
 * approval now takes it again when the card settles (agent.ts), because the user's main line does not stop
 * while they read. So each call has to measure from where the LAST one left the branch: a second report that
 * re-counted the commits the first already replayed onto would tell the agent its ground had moved twice, and
 * hand the turn's chore a span reaching back behind work that is already in main. */
test("a second sync in the same turn reports only what moved since the first", async () => {
    const { work, worktree, worktrees } = await setup();
    await writeFile(join(worktree, "app.ts"), "one\ntwo\nthree\nfour\nAGENT\n");
    await sh(worktree, "add", "-A");
    await commit(worktree, "agent work");
    // The main line moves before the turn starts...
    await writeFile(join(work, "other.ts"), "moved\n");
    await sh(work, "add", "-A");
    await commit(work, "user work");

    const [first] = await sync(worktrees);
    expect(first).toMatchObject({ commits: 1, moved: ["other.ts"], overlap: [] });

    // ...and again while the agent sits on its question, this time touching the file the agent is holding.
    await writeFile(join(work, "app.ts"), "USER\ntwo\nthree\nfour\nfive\n");
    await sh(work, "add", "-A");
    await commit(work, "user answered, then committed");

    const [second] = await sync(worktrees);
    expect(second).toMatchObject({ commits: 1, moved: ["app.ts"], overlap: ["app.ts"] });
    expect(second?.onto).toBe(await sh(work, "rev-parse", "HEAD"));
    // One agent commit, still on top: replayed twice, duplicated neither time.
    expect(await sh(worktree, "rev-list", "--count", `${await sh(work, "rev-parse", "HEAD")}..HEAD`)).toBe("1");
    expect(await readFile(join(worktree, "app.ts"), "utf8")).toBe("USER\ntwo\nthree\nfour\nAGENT\n");
});

// The ordinary answer at the second call: nobody committed while the card was up, so there is nothing to say
// and nothing is moved. This is what keeps a parked card from costing a rebase it did not need.
test("a second sync says nothing when the main line stood still", async () => {
    const { work, worktree, worktrees } = await setup();
    await writeFile(join(work, "other.ts"), "moved\n");
    await sh(work, "add", "-A");
    await commit(work, "user work");
    expect((await sync(worktrees)).length).toBe(1);

    const tip = await sh(worktree, "rev-parse", "HEAD");
    expect(await sync(worktrees)).toEqual([]);
    expect(await sh(worktree, "rev-parse", "HEAD")).toBe(tip);
});

test("rolls a conflicting rebase back and leaves the branch on its old base", async () => {
    const { work, worktree, worktrees } = await setup();
    const before = await sh(worktree, "rev-parse", "HEAD");
    // Both sides rewrite the SAME line: nothing git can replay.
    await writeFile(join(worktree, "app.ts"), "one\ntwo\nAGENT\nfour\nfive\n");
    await sh(worktree, "add", "-A");
    await commit(worktree, "agent work");
    await writeFile(join(work, "app.ts"), "one\ntwo\nUSER\nfour\nfive\n");
    await sh(work, "add", "-A");
    await commit(work, "user work");

    const [root] = await sync(worktrees);
    expect(root).toMatchObject({ repo: "root", blocked: true, commits: 1, overlap: ["app.ts"] });
    // Rolled all the way back: no rebase in progress, the agent's own commit still on top of its old base, and
    // its content untouched. This is the state the turn runs in: exactly today's behaviour, nothing worse.
    expect(await sh(worktree, "status", "--porcelain")).toBe("");
    expect(await sh(worktree, "rev-parse", "HEAD^")).toBe(before);
    expect(await readFile(join(worktree, "app.ts"), "utf8")).toBe("one\ntwo\nAGENT\nfour\nfive\n");
});

/* THE FAILURE THE RETRY WAS WRITTEN FOR, end to end through the real land: work lands, the user asks for a
 * correction in the same conversation, that lands too, the user commits, and the rebase at the top of the next
 * turn refused, over work already sitting in the main tree under the user's own name.
 *
 * The mechanism is SLICING, and it needs one commit of the user's to cover more than one of the agent's, which
 * is the ordinary case: a land leaves its delta uncommitted, so a second land stacks onto the same undisturbed
 * working tree and one `git commit` takes both. Turn one's commit takes `five` to AGENT-a and turn two's takes
 * it to AGENT-b, but the user's commit carries only the NET. Replaying turn one alone then puts AGENT-a against
 * AGENT-b over the same line, and no rebase can call that anything but a conflict, which left the conversation
 * stranded on a base that only got older.
 *
 * (Committing after EVERY land is the shape that survives, and only by luck: each user commit is then
 * patch-identical to one agent commit, and git's own cherry-pick detection drops it. Nothing about that is a
 * property anyone can rely on, as the next test shows, main only has to drift by a character to lose it.) */
test("a landed branch the user has committed moves onto the main line instead of refusing", async () => {
    const { work, worktree, worktrees } = await setup();
    const base = await sh(work, "rev-parse", "HEAD");
    await turn(worktree, () => writeFile(join(worktree, "app.ts"), "one\ntwo\nthree\nfour\nAGENT-a\n"));
    const first = await landAgent(worktrees, entryOf(base));
    expect(first.landed).toBe(true);
    // The correction, asked in the same conversation, on the same line. It lands onto a working tree that still
    // holds the first land, uncommitted.
    await turn(worktree, () => writeFile(join(worktree, "app.ts"), "one\ntwo\nthree\nfour\nAGENT-b\n"));
    const second = await landAgent(worktrees, entryOf(base, first.repos[0]?.landedTip));
    expect(second.landed).toBe(true);
    // One commit over both turns, which is what the Changes panel offers: the review boundary is the user's.
    await sh(work, "add", "-A");
    await commit(work, "user reviews and commits");
    const main = await sh(work, "rev-parse", "HEAD");

    const [root] = await sync(worktrees, second.repos[0]?.landedTip);
    expect(root?.blocked).toBeUndefined();
    // Both turns are already in the main tree, so nothing of the branch is replayed: it simply IS the main
    // line now. That count is also what distinguishes the two paths, a plain rebase would have left the two
    // landed commits sitting on top as replayed copies of content main already holds.
    expect(await sh(worktree, "rev-parse", "HEAD")).toBe(main);
    expect(await sh(worktree, "rev-list", "--count", `${main}..HEAD`)).toBe("0");
    expect(await readFile(join(worktree, "app.ts"), "utf8")).toBe("one\ntwo\nthree\nfour\nAGENT-b\n");
});

/* Only the DELIVERED prefix is dropped. Work the agent has done since its last land is the whole reason the
 * branch still exists, so it is replayed onto the main line exactly as before, and the retry is worth nothing
 * if it quietly eats it. Main drifts here (the user tidied the landed line before committing), which is what
 * makes the plain rebase refuse over a commit whose content has already been delivered. */
test("the retry keeps everything the agent has done since its last land", async () => {
    const { work, worktree, worktrees } = await setup();
    const base = await sh(work, "rev-parse", "HEAD");
    await turn(worktree, () => writeFile(join(worktree, "app.ts"), "one\ntwo\nthree\nfour\nAGENT\n"));
    const landed = await landAgent(worktrees, entryOf(base));
    expect(landed.landed).toBe(true);
    // The user edits the landed line before committing it: the main line now holds this work, but not verbatim.
    await writeFile(join(work, "app.ts"), "one\ntwo\nthree\nfour\nAGENT, tidied\n");
    await sh(work, "add", "-A");
    await commit(work, "user commits, with a tweak");
    const main = await sh(work, "rev-parse", "HEAD");
    // And the agent has kept working since, in a file nobody else has touched. Never landed.
    await turn(worktree, () => writeFile(join(worktree, "new.ts"), "outstanding\n"));

    const [root] = await sync(worktrees, landed.repos[0]?.landedTip);
    expect(root?.blocked).toBeUndefined();
    // Exactly one commit on top of the main line: the outstanding one. The landed one is gone, its content
    // being the user's commit underneath.
    expect(await sh(worktree, "rev-list", "--count", `${main}..HEAD`)).toBe("1");
    expect(await sh(worktree, "rev-parse", "HEAD^")).toBe(main);
    expect(await readFile(join(worktree, "new.ts"), "utf8")).toBe("outstanding\n");
    expect(await readFile(join(worktree, "app.ts"), "utf8")).toBe("one\ntwo\nthree\nfour\nAGENT, tidied\n");
});

/* A conflict in UNLANDED work is a real one, and the retry must not paper over it: dropping the landed prefix
 * leaves that commit to be replayed against the user's edit either way. Blocked, rolled back, byte-identical,
 * and the turn runs on its old base, which is what the land-time conflict flow is still there for. */
test("still refuses when the conflict is in work that has not landed", async () => {
    const { work, worktree, worktrees } = await setup();
    const base = await sh(work, "rev-parse", "HEAD");
    await turn(worktree, () => writeFile(join(worktree, "other.ts"), "agent touched this\n"));
    const landed = await landAgent(worktrees, entryOf(base));
    expect(landed.landed).toBe(true);
    await sh(work, "add", "-A");
    await commit(work, "user commits the landed work");
    // Outstanding work on a line the user then rewrites for themselves.
    await turn(worktree, () => writeFile(join(worktree, "app.ts"), "one\ntwo\nAGENT\nfour\nfive\n"));
    const before = await sh(worktree, "rev-parse", "HEAD");
    await writeFile(join(work, "app.ts"), "one\ntwo\nUSER\nfour\nfive\n");
    await sh(work, "add", "-A");
    await commit(work, "user work");

    const [root] = await sync(worktrees, landed.repos[0]?.landedTip);
    // `other.ts` is in the overlap too: the agent wrote it and the user committed it, which is what the retry
    // drops. It is `app.ts`, the unlanded half, that has nowhere to go.
    expect(root).toMatchObject({ repo: "root", blocked: true, overlap: ["app.ts", "other.ts"] });
    expect(await sh(worktree, "status", "--porcelain")).toBe("");
    expect(await sh(worktree, "rev-parse", "HEAD")).toBe(before);
    expect(await readFile(join(worktree, "app.ts"), "utf8")).toBe("one\ntwo\nAGENT\nfour\nfive\n");
});

/* The rung has to be an ancestor of the branch to name a span at all. A conversation that merged the main line
 * into itself, or that an earlier retry already rewrote, holds a `landedTip` pointing at a commit this history
 * no longer contains, and `--onto` past it would replay something nobody asked for. Refuse instead, exactly as
 * a conversation that has never landed does. */
test("ignores a landedTip the branch no longer descends from", async () => {
    const { work, worktree, worktrees } = await setup();
    const before = await sh(worktree, "rev-parse", "HEAD");
    await turn(worktree, () => writeFile(join(worktree, "app.ts"), "one\ntwo\nAGENT\nfour\nfive\n"));
    await writeFile(join(work, "app.ts"), "one\ntwo\nUSER\nfour\nfive\n");
    await sh(work, "add", "-A");
    await commit(work, "user work");

    // A sha off another line entirely: real, resolvable, and not an ancestor of anything here.
    const [root] = await sync(worktrees, await sh(work, "rev-parse", "HEAD"));
    expect(root).toMatchObject({ repo: "root", blocked: true, overlap: ["app.ts"] });
    expect(await sh(worktree, "rev-parse", "HEAD^")).toBe(before);
});

test("leaves a retired checkout alone", async () => {
    const { work, worktrees } = await setup();
    await worktrees.retire("c1", [{ repo: "root", base: await sh(work, "rev-parse", "HEAD") }], "fix the thing");
    await writeFile(join(work, "other.ts"), "moved\n");
    await sh(work, "add", "-A");
    await commit(work, "user work");
    expect(await sync(worktrees)).toEqual([]);
});

test("a synced branch still lands only its own work", async () => {
    const { work, worktree, worktrees } = await setup();
    const base = await sh(work, "rev-parse", "HEAD");
    await writeFile(join(worktree, "app.ts"), "one\ntwo\nthree\nfour\nAGENT\n");
    await sh(worktree, "add", "-A");
    await commit(worktree, "agent work");
    // The main line gains a file the agent has never seen. A land measured from the FROZEN base would carry it
    // back as the agent's own work and fail to apply; measured from the merge-base it is simply not in the span.
    await writeFile(join(work, "other.ts"), "moved\n");
    await sh(work, "add", "-A");
    await commit(work, "user work");

    await sync(worktrees);
    const entry = {
        id: "c1",
        branch: "agent/c1",
        title: "fix the thing",
        provider: "claude" as const,
        harness: "native" as const,
        isolated: true as const,
        repos: [{ repo: "root", base }],
        status: "idle" as const,
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        createdAt: 0,
        updatedAt: 0,
    };
    const outcome = await landAgent(worktrees, entry);
    expect(outcome.landed).toBe(true);
    expect(outcome.diff.files).toBe(1);
    expect(await readFile(join(work, "app.ts"), "utf8")).toBe("one\ntwo\nthree\nfour\nAGENT\n");
    expect(await readFile(join(work, "other.ts"), "utf8")).toBe("moved\n");
});

/* THE WINDOW BETWEEN THE TURN'S SYNC AND ITS LAND, which is where the conflict errand actually came from.
 *
 * The branch is put on today's main line before the model reads a line of it, and then the turn RUNS: a long
 * turn is half an hour, and in a fleet the user spends it landing and committing other agents. By the time this
 * turn's own delta is measured, main has moved again, and the land is `git apply --check` of a patch whose
 * CONTEXT lines no longer match the file it is being applied to. Nothing about this agent's work is in
 * conflict, the paperwork simply went stale.
 *
 * The two tests below are the same scenario with and without the last-moment rebase, which is the only
 * difference between a card that lands and a card that comes back red asking a model to resolve a merge. */
const midTurnDrift = async (): Promise<{ work: string; worktrees: AgentWorktrees; base: string }> => {
    const { work, worktree, worktrees } = await setup();
    const base = await sh(work, "rev-parse", "HEAD");
    // Turn start: the branch is already current, and the sync is the no-op it is on most turns.
    expect(await sync(worktrees)).toEqual([]);
    // The turn's own work, on the last line.
    await turn(worktree, () => writeFile(join(worktree, "app.ts"), "one\ntwo\nthree\nfour\nAGENT\n"));
    // ...and while it ran, the user landed something else and committed it, two lines up. Far enough that the
    // rebase merges both cleanly, close enough to sit inside the agent patch's own context lines, which is
    // exactly what makes `git apply` refuse work that does not really conflict.
    await writeFile(join(work, "app.ts"), "one\ntwo\nUSER\nfour\nfive\n");
    await sh(work, "add", "-A");
    await commit(work, "user landed another agent");
    return { work, worktrees, base };
};

test("without the last-moment rebase, a land refuses over main-line movement it never touched", async () => {
    const { work, worktrees, base } = await midTurnDrift();
    const outcome = await landAgent(worktrees, entryOf(base));
    expect(outcome.landed).toBe(false);
    // `diverged` is the tell: not "you both edited this line" but "the tree moved under the patch".
    expect(outcome.conflicts?.[0]?.paths).toEqual([{ path: "app.ts", reason: "diverged" }]);
    // The user's tree is untouched by the refusal: all of it or none.
    expect(await readFile(join(work, "app.ts"), "utf8")).toBe("one\ntwo\nUSER\nfour\nfive\n");
});

test("with it, the same turn lands clean and both edits survive", async () => {
    const { work, worktrees, base } = await midTurnDrift();
    const recorded: { id: string; repos: readonly { repo: string; base: string }[] }[] = [];
    const repos = await syncBeforeLand(worktrees, { id: "c1", title: "fix the thing", repos: entryOf(base).repos }, async (id, next) => {
        recorded.push({ id, repos: next });
    });
    // The composition it hands back names where the branch NOW sits, and the registry was told.
    expect(repos[0]?.base).toBe(await sh(work, "rev-parse", "HEAD"));
    expect(recorded).toHaveLength(1);

    const outcome = await landAgent(worktrees, { ...entryOf(base), repos: [...repos] });
    expect(outcome.landed).toBe(true);
    expect(outcome.conflicts).toBeUndefined();
    expect(await readFile(join(work, "app.ts"), "utf8")).toBe("one\ntwo\nUSER\nfour\nAGENT\n");
    // And only the agent's own line is offered as its work: the user's commit is in main by ancestry now.
    expect(outcome.diff.files).toBe(1);
});

// The ordinary turn, where nothing moved: no rebase, no registry write, and the composition comes back as it
// went in. This is most turns, and it must cost one merge-base per repo and nothing else.
test("is a no-op on a branch that is already current", async () => {
    const { work, worktrees } = await setup();
    const base = await sh(work, "rev-parse", "HEAD");
    const recorded: string[] = [];
    const repos = await syncBeforeLand(worktrees, { id: "c1", title: "t", repos: entryOf(base).repos }, async (id) => {
        recorded.push(id);
    });
    expect(repos).toEqual(entryOf(base).repos);
    expect(recorded).toEqual([]);
});
