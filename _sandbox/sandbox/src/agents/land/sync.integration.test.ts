import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { ensureRootRepo } from "../../git/remote/root-repo.js";
import { createLogger } from "../../logger.js";
import { createPerfTracker } from "../../platform/resources/perf.js";
import { noIsolation } from "../../testing.js";
import { workspacePaths } from "../../workspace/workspace.js";
import type { IsolatedAgent } from "../registry/agents-store.js";
import { landAgent } from "./land.js";
import { syncBeforeLand, syncConversation } from "./sync.js";
import { createAgentWorktrees, type AgentWorktrees } from "../worktrees/worktrees.js";

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

// Two files: `app.ts` is what both sides fight over, `other.ts` is what the main line moves without the agent noticing.
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

// The registry row a real land reads, so tests produce `landedTip` the way a turn does, not a hand-picked sha.
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

// One turn's work, committed on the branch the way land's own provenance commit does.
const turn = async (worktree: string, write: () => Promise<void>): Promise<void> => {
    await write();
    await sh(worktree, "add", "-A");
    await commit(worktree, "agent work");
};

test("reports nothing when the branch already sits on the main line", async () => {
    const { worktrees } = await setup();
    expect(await sync(worktrees)).toEqual([]);
});

// `--name-only` reports a rename only at its destination: main renaming a file the agent edits makes two path lists
// that can't intersect, naming nothing on the file about to be replayed onto a gone path.
test("a main-line RENAME of a file the agent edited is reported as an overlap", async () => {
    const { work, worktree, worktrees } = await setup();
    await writeFile(join(worktree, "app.ts"), "one\ntwo\nthree\nfour\nAGENT\n");
    await sh(worktree, "add", "-A");
    await commit(worktree, "agent work");
    // Main moves the very file the agent is holding, verbatim: a 100% rename, the case that collapses.
    await sh(work, "mv", "app.ts", "renamed.ts");
    await commit(work, "user renamed it");

    const [root] = await sync(worktrees);
    // Both halves of the rename are what main did; the source is where the agent's work sits.
    expect(root?.moved).toEqual(["app.ts", "renamed.ts"]);
    expect(root?.overlap).toEqual(["app.ts"]);
});

test("replays the agent's commits onto a main line that moved, and says what moved", async () => {
    const { work, worktree, worktrees } = await setup();
    await writeFile(join(worktree, "app.ts"), "one\ntwo\nthree\nfour\nAGENT\n");
    await sh(worktree, "add", "-A");
    await commit(worktree, "agent work");
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
    expect(await readFile(join(worktree, "app.ts"), "utf8")).toBe("USER\ntwo\nthree\nfour\nAGENT\n");
    // And the branch really is rebased on top of the main line now, not merely holding its content.
    expect(await sh(worktree, "rev-list", "--count", `${await sh(work, "rev-parse", "HEAD")}..HEAD`)).toBe("1");
});

test("commits the worktree's dirty remainder first: a rebase refuses to start otherwise", async () => {
    const { work, worktree, worktrees } = await setup();
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
    // The remainder is provenance: it carries the agent title and the daemon's identity, land's own commit.
    expect(await sh(worktree, "log", "-1", "--format=%s%n%an")).toBe("Agent: fix the thing\nintentic");
});

// A parked or approval-waiting turn re-syncs when the card settles, since main doesn't stop moving while the user
// reads; each call measures from where the last one left the branch.
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

    // ...and again while the agent sits on its question, this time touching the file it holds.
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
    // Both sides rewrite the same line: nothing git can replay.
    await writeFile(join(worktree, "app.ts"), "one\ntwo\nAGENT\nfour\nfive\n");
    await sh(worktree, "add", "-A");
    await commit(worktree, "agent work");
    await writeFile(join(work, "app.ts"), "one\ntwo\nUSER\nfour\nfive\n");
    await sh(work, "add", "-A");
    await commit(work, "user work");

    const [root] = await sync(worktrees);
    expect(root).toMatchObject({ repo: "root", blocked: true, commits: 1, overlap: ["app.ts"] });
    // Rolled all the way back: no rebase in progress, the agent's commit still on its old base, untouched.
    expect(await sh(worktree, "status", "--porcelain")).toBe("");
    expect(await sh(worktree, "rev-parse", "HEAD^")).toBe(before);
    expect(await readFile(join(worktree, "app.ts"), "utf8")).toBe("one\ntwo\nAGENT\nfour\nfive\n");
});

// One user commit can cover more than one agent commit, since a land leaves its delta uncommitted and a second stacks
// onto the same tree: replaying an earlier agent commit alone then pits it against a later one over the same line.
test("a landed branch the user has committed moves onto the main line instead of refusing", async () => {
    const { work, worktree, worktrees } = await setup();
    const base = await sh(work, "rev-parse", "HEAD");
    await turn(worktree, () => writeFile(join(worktree, "app.ts"), "one\ntwo\nthree\nfour\nAGENT-a\n"));
    const first = await landAgent(worktrees, entryOf(base));
    expect(first.landed).toBe(true);
    // The correction lands onto a working tree that still holds the first land, uncommitted.
    await turn(worktree, () => writeFile(join(worktree, "app.ts"), "one\ntwo\nthree\nfour\nAGENT-b\n"));
    const second = await landAgent(worktrees, entryOf(base, first.repos[0]?.landedTip));
    expect(second.landed).toBe(true);
    // One commit over both turns, which is what the Changes panel offers: the review boundary is the user's.
    await sh(work, "add", "-A");
    await commit(work, "user reviews and commits");
    const main = await sh(work, "rev-parse", "HEAD");

    const [root] = await sync(worktrees, second.repos[0]?.landedTip);
    expect(root?.blocked).toBeUndefined();
    // Both turns are already in main, so nothing replays; a plain rebase would leave two redundant commits on top.
    expect(await sh(worktree, "rev-parse", "HEAD")).toBe(main);
    expect(await sh(worktree, "rev-list", "--count", `${main}..HEAD`)).toBe("0");
    expect(await readFile(join(worktree, "app.ts"), "utf8")).toBe("one\ntwo\nthree\nfour\nAGENT-b\n");
});

// Main drifts here (the user tidied the landed line before committing), which is what makes a plain rebase refuse over
// content that has already been delivered.
test("the retry keeps everything the agent has done since its last land", async () => {
    const { work, worktree, worktrees } = await setup();
    const base = await sh(work, "rev-parse", "HEAD");
    await turn(worktree, () => writeFile(join(worktree, "app.ts"), "one\ntwo\nthree\nfour\nAGENT\n"));
    const landed = await landAgent(worktrees, entryOf(base));
    expect(landed.landed).toBe(true);
    // The user edits the landed line before committing: main now holds this work, but not verbatim.
    await writeFile(join(work, "app.ts"), "one\ntwo\nthree\nfour\nAGENT, tidied\n");
    await sh(work, "add", "-A");
    await commit(work, "user commits, with a tweak");
    const main = await sh(work, "rev-parse", "HEAD");
    await turn(worktree, () => writeFile(join(worktree, "new.ts"), "outstanding\n"));

    const [root] = await sync(worktrees, landed.repos[0]?.landedTip);
    expect(root?.blocked).toBeUndefined();
    // One commit on top of main, the outstanding one; the landed one is gone, its content now the user's.
    expect(await sh(worktree, "rev-list", "--count", `${main}..HEAD`)).toBe("1");
    expect(await sh(worktree, "rev-parse", "HEAD^")).toBe(main);
    expect(await readFile(join(worktree, "new.ts"), "utf8")).toBe("outstanding\n");
    expect(await readFile(join(worktree, "app.ts"), "utf8")).toBe("one\ntwo\nthree\nfour\nAGENT, tidied\n");
});

// Dropping the landed prefix still leaves this unlanded commit to replay against the user's edit either way, which the
// land-time conflict flow correctly refuses.
test("still refuses when the conflict is in work that has not landed", async () => {
    const { work, worktree, worktrees } = await setup();
    const base = await sh(work, "rev-parse", "HEAD");
    await turn(worktree, () => writeFile(join(worktree, "other.ts"), "agent touched this\n"));
    const landed = await landAgent(worktrees, entryOf(base));
    expect(landed.landed).toBe(true);
    await sh(work, "add", "-A");
    await commit(work, "user commits the landed work");
    await turn(worktree, () => writeFile(join(worktree, "app.ts"), "one\ntwo\nAGENT\nfour\nfive\n"));
    const before = await sh(worktree, "rev-parse", "HEAD");
    await writeFile(join(work, "app.ts"), "one\ntwo\nUSER\nfour\nfive\n");
    await sh(work, "add", "-A");
    await commit(work, "user work");

    const [root] = await sync(worktrees, landed.repos[0]?.landedTip);
    // `other.ts` is in the overlap too, but only `app.ts`, the unlanded half, has nowhere to go.
    expect(root).toMatchObject({ repo: "root", blocked: true, overlap: ["app.ts", "other.ts"] });
    expect(await sh(worktree, "status", "--porcelain")).toBe("");
    expect(await sh(worktree, "rev-parse", "HEAD")).toBe(before);
    expect(await readFile(join(worktree, "app.ts"), "utf8")).toBe("one\ntwo\nAGENT\nfour\nfive\n");
});

// The rung records that a land happened, never that it is still there: discarding landed files in the Changes panel
// moves no sha at all. Dropping the prefix on the strength of the record alone deleted a finished conversation's whole
// delta — branch reset onto main, no diff, no Land now — the one time main had also moved on a file it touched.
test("refuses instead of dropping a landed prefix the user has discarded", async () => {
    const { work, worktree, worktrees } = await setup();
    const base = await sh(work, "rev-parse", "HEAD");
    await turn(worktree, async () => {
        await writeFile(join(worktree, "app.ts"), "one\ntwo\nthree\nfour\nAGENT\n");
        await writeFile(join(worktree, "new.ts"), "the agent's own file\n");
    });
    const landed = await landAgent(worktrees, entryOf(base));
    expect(landed.landed).toBe(true);
    const tip = await sh(worktree, "rev-parse", "HEAD");

    // The user discards the whole land: the edit reverted, the new file deleted. Nothing about this moves a sha.
    await sh(work, "checkout", "--", "app.ts");
    await rm(join(work, "new.ts"));
    // Then lands another agent over the same line and commits it, which is what makes the plain rebase refuse.
    await writeFile(join(work, "app.ts"), "one\ntwo\nthree\nfour\nANOTHER\n");
    await sh(work, "add", "-A");
    await commit(work, "user lands another agent");

    const [root] = await sync(worktrees, landed.repos[0]?.landedTip);
    expect(root).toMatchObject({ repo: "root", blocked: true, overlap: ["app.ts"] });
    // The conversation still holds its work, offered again as a conflict to resolve rather than silently gone.
    expect(await sh(worktree, "rev-parse", "HEAD")).toBe(tip);
    expect(await sh(worktree, "status", "--porcelain")).toBe("");
    expect(await readFile(join(worktree, "new.ts"), "utf8")).toBe("the agent's own file\n");
});

// A land leaves its content in the main tree uncommitted, so a file it created sits there untracked: present, and
// invisible to every diff. Reading that as a vanished land would refuse every ordinary post-land sync.
test("still drops a landed prefix whose new file sits untracked in the main tree", async () => {
    const { work, worktree, worktrees } = await setup();
    const base = await sh(work, "rev-parse", "HEAD");
    await turn(worktree, async () => {
        await writeFile(join(worktree, "app.ts"), "one\ntwo\nthree\nfour\nAGENT\n");
        await writeFile(join(worktree, "new.ts"), "the agent's own file\n");
    });
    const landed = await landAgent(worktrees, entryOf(base));
    expect(landed.landed).toBe(true);
    // The user commits their own tidy of the landed line and leaves `new.ts` where the land put it, untracked.
    await writeFile(join(work, "app.ts"), "one\ntwo\nthree\nfour\nAGENT, tidied\n");
    await sh(work, "add", "app.ts");
    await commit(work, "user commits, with a tweak");
    const main = await sh(work, "rev-parse", "HEAD");

    const [root] = await sync(worktrees, landed.repos[0]?.landedTip);
    expect(root?.blocked).toBeUndefined();
    // Everything the prefix carried is accounted for, so it drops: the branch sits on main with nothing outstanding.
    expect(await sh(worktree, "rev-parse", "HEAD")).toBe(main);
    expect(await sh(worktree, "rev-list", "--count", `${main}..HEAD`)).toBe("0");
});

// A `landedTip` the branch no longer descends from (a merged-in main line, an earlier rewrite) would make `--onto`
// replay something nobody asked for; refused like a branch that never landed.
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
    // From the frozen base this file would wrongly count as the agent's; from the merge-base it's outside the span.
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

// Sync runs at turn start, but a long turn leaves time for main to move again before the land, so the land's `apply
// --check` sees a patch whose context no longer matches, though nothing about the work itself conflicts.
const midTurnDrift = async (): Promise<{ work: string; worktrees: AgentWorktrees; base: string }> => {
    const { work, worktree, worktrees } = await setup();
    const base = await sh(work, "rev-parse", "HEAD");
    expect(await sync(worktrees)).toEqual([]);
    await turn(worktree, () => writeFile(join(worktree, "app.ts"), "one\ntwo\nthree\nfour\nAGENT\n"));
    // Two lines up: far enough to rebase cleanly, close enough to sit in the patch's own context lines.
    await writeFile(join(work, "app.ts"), "one\ntwo\nUSER\nfour\nfive\n");
    await sh(work, "add", "-A");
    await commit(work, "user landed another agent");
    return { work, worktrees, base };
};

test("without the last-moment rebase, a land refuses over main-line movement it never touched", async () => {
    const { work, worktrees, base } = await midTurnDrift();
    const outcome = await landAgent(worktrees, entryOf(base));
    expect(outcome.landed).toBe(false);
    // `diverged` is the tell: not 'you both edited this line' but 'the tree moved under the patch'.
    expect(outcome.conflicts?.[0]?.paths).toEqual([{ path: "app.ts", reason: "diverged" }]);
    // The refusal touches nothing: the user's tree is untouched, all of it or none.
    expect(await readFile(join(work, "app.ts"), "utf8")).toBe("one\ntwo\nUSER\nfour\nfive\n");
});

test("with it, the same turn lands clean and both edits survive", async () => {
    const { work, worktrees, base } = await midTurnDrift();
    const recorded: { id: string; repos: readonly { repo: string; base: string }[] }[] = [];
    const repos = await syncBeforeLand(worktrees, { id: "c1", title: "fix the thing", repos: entryOf(base).repos }, async (id, next) => {
        recorded.push({ id, repos: next });
    });
    // The composition it hands back names where the branch now sits, and the registry was told.
    expect(repos[0]?.base).toBe(await sh(work, "rev-parse", "HEAD"));
    expect(recorded).toHaveLength(1);

    const outcome = await landAgent(worktrees, { ...entryOf(base), repos: [...repos] });
    expect(outcome.landed).toBe(true);
    expect(outcome.conflicts).toBeUndefined();
    expect(await readFile(join(work, "app.ts"), "utf8")).toBe("one\ntwo\nUSER\nfour\nAGENT\n");
    // Only the agent's own line is offered as its work: the user's commit is in main by ancestry now.
    expect(outcome.diff.files).toBe(1);
});

// The ordinary turn: nothing moved, so the composition returns unchanged and nothing is recorded.
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
