import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { afterEach, expect, test } from "vitest";
import { isolatedAgent, noIsolation } from "../testing.js";
import { ensureRootRepo } from "../git/root-repo.js";
import { createLogger } from "../logger.js";
import { createPerfTracker } from "../platform/perf.js";
import { workspacePaths } from "../workspace/workspace.js";
import type { AgentsRegistry } from "./agents-registry.js";
import type { PersistedAgent } from "./agents-store.js";
import { createExpiryTracker } from "./expiry.js";
import { landAgent } from "./land.js";
import { createAgentOrigins } from "./origins.js";
import { createAgentWorktrees, type AgentWorktrees, type ConversationWorktree } from "./worktrees.js";

/* Attribution is derived from the landed shas, so these run against a REAL land into a real main tree: the
 * only way to prove the derivation matches what the patch actually did. The registry is stubbed down to the
 * three methods origins touches (ids/entry/markLandingAbsorbed); everything else on it is irrelevant here. */

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });
const perf = createPerfTracker(logger);

// The baseline file with one line rewritten: the two agents take far-apart lines of it.
const LINES = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
const edited = (line: number): string => `${LINES.map((text, index) => (index === line - 1 ? `${text} EDITED` : text)).join("\n")}\n`;

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

const setup = async (): Promise<{ work: string; worktrees: AgentWorktrees; conversation: ConversationWorktree }> => {
    const base = await mkdtemp(join(tmpdir(), "intentic-origins-"));
    tempDirs.push(base);
    const work = join(base, "work");
    const historyRoot = join(base, "history");
    const workspace = workspacePaths(work);
    await mkdir(work, { recursive: true });
    await ensureRootRepo(workspace, historyRoot);
    // Long enough that two agents can edit far-apart regions of it and both patches still apply.
    await writeFile(join(work, "app.ts"), `${LINES.join("\n")}\n`);
    await writeFile(join(work, "other.ts"), "untouched\n");
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
    return { work, worktrees, conversation: await worktrees.ensure("c1", []) };
};

// Only ids(), entry() and markLandingAbsorbed() run; the rest of the registry surface never does. The mark
// mutates the row in place with the real registry's guard, so the tests exercise the same contract the
// daemon persists: including the restart-survival the mark exists for (a fresh origins instance over the
// same entries reads no git for an absorbed landing).
const registryOf = (...entries: PersistedAgent[]): AgentsRegistry =>
    ({
        ids: () => entries.map((entry) => entry.id),
        entry: (id: string) => entries.find((entry) => entry.id === id),
        markLandingAbsorbed: async (id: string, repo: string, landedHead: string, landedTip: string, size: number) => {
            const row = entries.find((entry) => entry.id === id)?.repos.find((composed) => composed.repo === repo);
            if (row === undefined || row.landedHead !== landedHead || row.landedTip !== landedTip || row.absorbed !== undefined) {
                return;
            }
            (row as { absorbed?: number }).absorbed = size;
        },
    }) as unknown as AgentsRegistry;

// Origins over a stub registry and a fresh shared-expiry tracker: every test's default wiring. `git` rides
// into BOTH readers, so a counting runner sees every spawn attribution costs.
const originsOf = (agents: AgentsRegistry, git: GitRunner = defaultGit): ReturnType<typeof createAgentOrigins> =>
    createAgentOrigins({ agents, logger, expiry: createExpiryTracker(git) }, git);

test("a landed file is credited to the agent that landed it; untouched files are unattributed", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), edited(1));
    await writeFile(join(conversation.cwd, "added.ts"), "new file\n");
    const landed = await landAgent(worktrees, isolatedAgent(conversation.repos));

    const origins = originsOf(registryOf(isolatedAgent(landed.repos)));
    expect(await origins.forRepo("root", work)).toEqual({ "app.ts": ["c1"], "added.ts": ["c1"] });
});

test("nothing landed ⇒ nothing claimed", async () => {
    const { work, worktrees, conversation } = await setup();
    const origins = originsOf(registryOf(isolatedAgent(conversation.repos)));
    expect(await origins.forRepo("root", work)).toEqual({});
    // Same for a repo the agent's composition doesn't even include.
    await worktrees.remove("c1", conversation.repos);
    expect(await origins.forRepo("nested", work)).toEqual({});
});

test("a path two agents landed lists both, newest land first", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), edited(1));
    const first = await landAgent(worktrees, isolatedAgent(conversation.repos));

    const second = await worktrees.ensure("c2", []);
    // The LAST line, far from c1's hunk: land is context-based, so a second agent's patch applies cleanly
    // over work already sitting in the tree as long as the hunks don't overlap, which is exactly how one
    // uncommitted file ends up owned by two agents at once.
    await writeFile(join(second.cwd, "app.ts"), edited(12));
    const later = await landAgent(worktrees, isolatedAgent(second.repos, { id: "c2" }));

    // c2 landed after c1: both own the path, and the most recent author reads first.
    const agents = registryOf(isolatedAgent(first.repos), isolatedAgent(later.repos, { id: "c2" }));
    expect((await originsOf(agents).forRepo("root", work))[`app.ts`]).toEqual(["c2", "c1"]);
});

test("committing one agent's work leaves another agent's landed files attributed", async () => {
    const { work, worktrees, conversation } = await setup();
    // c1 lands app.ts, c2 lands other.ts: two agents waiting in the same tree, which is the normal board.
    await writeFile(join(conversation.cwd, "app.ts"), edited(1));
    const first = await landAgent(worktrees, isolatedAgent(conversation.repos));
    const second = await worktrees.ensure("c2", []);
    await writeFile(join(second.cwd, "other.ts"), "c2 was here\n");
    const later = await landAgent(worktrees, isolatedAgent(second.repos, { id: "c2" }));

    // The user reviews c2 and commits ONLY other.ts. HEAD moves, but nothing has happened to app.ts…
    await sh(work, "add", "other.ts");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "reviewed c2");

    // …so c1 keeps its file and c2's (now in history) drops out. A repo-wide expiry would blank both.
    const origins = originsOf(registryOf(isolatedAgent(first.repos), isolatedAgent(later.repos, { id: "c2" })));
    expect(await origins.forRepo("root", work)).toEqual({ "app.ts": ["c1"] });
});

/* A RENAME IS ONE CHANGE ACROSS TWO PATHS, and attribution has to name both: the bug this test exists for.
 *
 * land.ts already learned this the hard way (see DeltaChange there): `--name-only` reports a rename at its
 * destination and NOWHERE ELSE, so a delta read that way carries the add and drops the delete. Origins read
 * its spans the same way, and the consequence landed on the user rather than on the tree: the land correctly
 * deleted the source, but nothing could attribute that deletion, so the Changes panel counted the `D` row as
 * "yours". Filter to the agent that did the rename and the row VANISHES from the list: "Stage all" under that
 * filter cannot stage what it is not showing, the commit goes in carrying only the add, and the deletion is
 * left sitting in the tree for the user to find and commit by hand. Which is exactly what happened. */
test("a rename credits BOTH paths to the agent: the deletion is its work as much as the addition", async () => {
    const { work, worktrees, conversation } = await setup();
    // Moved verbatim, so git scores it a 100% rename: the case that collapses to one path.
    await rm(join(conversation.cwd, "app.ts"));
    await mkdir(join(conversation.cwd, "moved"), { recursive: true });
    await writeFile(join(conversation.cwd, "moved/app.ts"), `${LINES.join("\n")}\n`);
    const landed = await landAgent(worktrees, isolatedAgent(conversation.repos));

    // The land itself gets this right: both halves are in the tree.
    expect(await sh(work, "status", "--porcelain")).toContain("app.ts");

    const origins = originsOf(registryOf(isolatedAgent(landed.repos)));
    expect(await origins.forRepo("root", work)).toEqual({ "app.ts": ["c1"], "moved/app.ts": ["c1"] });
});

/* The expiry's own half of the same rule. The comment on committedSince has always said a commit that renames
 * a landed path must retire BOTH names, but OMITTING `-M` does not turn rename detection off, because git has
 * defaulted diff.renames to true since 2.9. So the source name went on being claimed by an agent, on a path
 * that no longer exists, until something else retired it. */
test("committing a rename of a landed path retires BOTH of its names", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), edited(1));
    const landed = await landAgent(worktrees, isolatedAgent(conversation.repos));

    // The user takes the agent's file and commits it under a new name: history has now absorbed both.
    await sh(work, "mv", "app.ts", "renamed.ts");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "reviewed and renamed");

    const origins = originsOf(registryOf(isolatedAgent(landed.repos)));
    expect(await origins.forRepo("root", work)).toEqual({});
});

test("identify names an ARCHIVED agent: the roster the client mirrors no longer carries it", async () => {
    // The whole reason identity rides the response: archiving a finished agent takes it off the fleet roster
    // (AgentsRegistry.list drops archived entries) but does NOT commit its landed lines, so the panel is
    // reviewing work whose author the client can no longer look up. Reading `entry` covers both halves.
    const archived = { ...isolatedAgent([], { id: "c1" }), archivedAt: 1 };
    const untitled = { ...isolatedAgent([], { id: "c2" }) };
    delete untitled.title;
    const origins = originsOf(registryOf(archived, untitled));
    expect(origins.identify(["c1", "c2", "gone"])).toEqual({
        c1: { provider: "claude", title: "fix the thing" },
        // No title ⇒ the key is absent rather than empty, and an id with no entry left at all is omitted
        // entirely: the panel's id-shaped fallback is what covers it.
        c2: { provider: "claude" },
    });
});

test("a re-land after a rebase claims only the new delta, not the main-line commits the rebase pulled in", async () => {
    const { work, worktrees, conversation } = await setup();
    // c1 lands app.ts and the user reviews and commits it: the ordinary first half of a review.
    await writeFile(join(conversation.cwd, "app.ts"), edited(1));
    const first = await landAgent(worktrees, isolatedAgent(conversation.repos));
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "reviewed app.ts");
    const reviewed = await sh(work, "rev-parse", "HEAD");

    // The agent keeps going: told the main tree moved on, it rebases onto it, so its branch now CONTAINS the
    // user's commit, and lands a second, unrelated file.
    await sh(conversation.cwd, "-c", "user.name=t", "-c", "user.email=t@t", "rebase", reviewed);
    await writeFile(join(conversation.cwd, "other.ts"), "c1 was here\n");
    const second = await landAgent(worktrees, isolatedAgent(first.repos));

    // Only the new delta is this agent's. Measured from the frozen base it would ALSO claim app.ts, and the
    // per-path expiry cannot save it: landedHead advanced PAST the commit of app.ts on this very land, so
    // `landedHead..HEAD` is empty and the phantom claim would never retire. That is the chip that puts a stale
    // session's title in the commit box and gets the same work committed twice.
    const origins = originsOf(registryOf(isolatedAgent(second.repos)));
    expect(await origins.forRepo("root", work)).toEqual({ "other.ts": ["c1"] });
});

test("a re-land WITHOUT a rebase drops the delta the user committed in between", async () => {
    const { work, worktrees, conversation } = await setup();
    // The same first half as the test above: c1 lands app.ts, the user reviews and commits it…
    await writeFile(join(conversation.cwd, "app.ts"), edited(1));
    const first = await landAgent(worktrees, isolatedAgent(conversation.repos));
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "reviewed app.ts");

    // …except this branch is never rebased onto that commit, which is the ordinary case rather than the
    // exception: a rebase runs when a turn STARTS, and an agent that keeps working through several lands
    // rebases on nobody's schedule. So the merge-base stays behind the commit and app.ts stays in the span,
    // while `landedHead` advances onto it: the exact pair of shas the per-path expiry cannot resolve.
    await writeFile(join(conversation.cwd, "other.ts"), "c1 was here\n");
    const second = await landAgent(worktrees, isolatedAgent(first.repos));

    // Only the new delta is claimed: app.ts was already in the tree, committed, when this land went in, so the
    // land put nothing of its own there. Measured from the span alone the claim on app.ts never expires…
    const origins = originsOf(registryOf(isolatedAgent(second.repos)));
    expect(await origins.forRepo("root", work)).toEqual({ "other.ts": ["c1"] });

    // …and it costs nothing until someone touches the file, which is what made it so hard to see: a finished
    // session reappearing in the Changes panel days later, on a row it has no lines in.
    await writeFile(join(work, "app.ts"), `${edited(1)}later work\n`);
    expect(await origins.forRepo("root", work)).toEqual({ "other.ts": ["c1"] });
});

test("a path the user committed BEFORE the land stays credited: only commits after it retire the claim", async () => {
    const { work, worktrees, conversation } = await setup();
    // Main moves while the agent works, on the very file the agent is editing. The worktree was branched
    // before this commit, so the merge-base sits BEHIND it.
    await writeFile(join(work, "app.ts"), edited(12));
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "user edits the last line");

    // The agent lands a far-apart hunk of that same file, so its patch still applies over the user's commit.
    await writeFile(join(conversation.cwd, "app.ts"), edited(1));
    const landed = await landAgent(worktrees, isolatedAgent(conversation.repos));

    // The agent's lines are sitting uncommitted in the tree RIGHT NOW, so it keeps the credit. This is why the
    // expiry stays anchored at landedHead and is NOT folded into the merge-base for symmetry: from the
    // merge-base, the user's EARLIER commit reads as "history has absorbed this path" and the agent's own
    // uncommitted work gets handed to the user.
    const origins = originsOf(registryOf(isolatedAgent(landed.repos)));
    expect(await origins.forRepo("root", work)).toEqual({ "app.ts": ["c1"] });
});

// Records every git command a scan issues, so the two tests below can assert what a scan does NOT read. Both
// are about cost, and cost is the whole reason this file caches: a fleet accumulates landings forever, and
// re-deriving each of them on every scan is what made the Changes panel take 10-20s to answer after a commit.
const countingGit =
    (calls: string[][]): GitRunner =>
    (dir, args, env) => {
        calls.push([...args]);
        return defaultGit(dir, args, env);
    };

test("an absorbed claim is never re-derived, not by the next scan, and not by the next PROCESS", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), edited(1));
    const landed = await landAgent(worktrees, isolatedAgent(conversation.repos));

    const calls: string[][] = [];
    const entry = isolatedAgent(landed.repos);
    const registry = registryOf(entry);
    const origins = originsOf(registry, countingGit(calls));
    expect(await origins.forRepo("root", work)).toEqual({ "app.ts": ["c1"] });

    // The user reviews and commits it. The scan that discovers the claim is over is the LAST one to spend
    // anything on it: history absorbing every landed path is a one-way door, recorded on the entry.
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "reviewed");
    expect(await origins.forRepo("root", work)).toEqual({});
    expect(entry.repos[0]?.absorbed).toBe(1);

    calls.length = 0;
    expect(await origins.forRepo("root", work)).toEqual({});
    // Not one command: the landing is dropped before the HEAD read, so a fleet of archived agents whose work
    // shipped months ago costs the panel nothing. It used to cost two diffs each, on every commit, forever.
    expect(calls).toEqual([]);

    // The mark is on the PERSISTED entry, so a fresh instance (a daemon restart) starts already knowing.
    // The in-memory memo this replaces re-derived every landing the fleet ever made on the first scan after
    // every reboot, which is what made that scan take 10-20 seconds.
    expect(await originsOf(registry, countingGit(calls)).forRepo("root", work)).toEqual({});
    expect(calls).toEqual([]);
});

test("advancing HEAD does not re-read a merge-base: the branch point cannot move under a landing", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), edited(1));
    const landed = await landAgent(worktrees, isolatedAgent(conversation.repos));

    const calls: string[][] = [];
    const origins = originsOf(registryOf(isolatedAgent(landed.repos)), countingGit(calls));
    expect(await origins.forRepo("root", work)).toEqual({ "app.ts": ["c1"] });
    expect(calls.filter((args) => args[0] === "merge-base")).toHaveLength(1);

    // The user commits a file of their own. HEAD moves, so the claim is re-measured against it, but where the
    // agent's branch left the main line has not moved, and asking git again could only ever get the same sha.
    await writeFile(join(work, "unrelated.ts"), "user work\n");
    await sh(work, "add", "unrelated.ts");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "user commits their own file");

    calls.length = 0;
    expect(await origins.forRepo("root", work)).toEqual({ "app.ts": ["c1"] });
    expect(calls.filter((args) => args[0] === "merge-base")).toEqual([]);
});

/* THE LEAK REGRESSION. The expiry span ends at the MOVING head, and it used to be cached under a key that
 * included it: one dead entry per landing at every commit, holding a path list whose sliced strings pinned the
 * whole diff listing they were split from. On a real fleet (~800 landings, ~100 commits a day) that was
 * gigabytes of daemon heap per day, released only by a restart. The contract now: a superseded head's entry is
 * REPLACED, so the caches stay flat however far HEAD runs, and a retired landing takes its entries with it. */
test("advancing HEAD replaces the expiry entry: the caches do not grow with the commit count", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), edited(1));
    const landed = await landAgent(worktrees, isolatedAgent(conversation.repos));

    const expiry = createExpiryTracker();
    const origins = createAgentOrigins({ agents: registryOf(isolatedAgent(landed.repos)), logger, expiry });
    expect(await origins.forRepo("root", work)).toEqual({ "app.ts": ["c1"] });
    const { pathCharacters: _content, ...settled } = origins.metrics();

    // Three commits of the user's own file: three head moves, each re-measuring the claim.
    for (let round = 0; round < 3; round += 1) {
        await writeFile(join(work, "unrelated.ts"), `user work ${round}\n`);
        await sh(work, "add", "unrelated.ts");
        await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", `user commit ${round}`);
        expect(await origins.forRepo("root", work)).toEqual({ "app.ts": ["c1"] });
    }
    // Same cardinalities as after the first scan: nothing accumulated per head move, in this module's own
    // spans, and in the shared expiry tracker whose CONTENT may grow (the diff since the land legitimately
    // names the user's new file) but only ever inside the one slot per landing.
    const { pathCharacters: _grown, ...after } = origins.metrics();
    expect(after).toEqual(settled);
    expect(expiry.metrics()["entries"]).toBe(1);

    // The user commits the landed work: the claim retires, and its cached spans go with it, tracker included.
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "reviewed");
    expect(await origins.forRepo("root", work)).toEqual({});
    expect(origins.metrics()).toEqual({ spans: 0, anchors: 0, unresolvable: 0, pathCharacters: 0 });
    expect(expiry.metrics()["entries"]).toBe(0);
});

test("the claim expires when the user commits: a file that goes dirty again is theirs, not the agent's", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), edited(1));
    const landed = await landAgent(worktrees, isolatedAgent(conversation.repos));
    const origins = originsOf(registryOf(isolatedAgent(landed.repos)));
    expect(await origins.forRepo("root", work)).toEqual({ "app.ts": ["c1"] });

    // The user reviews and commits it. HEAD moves off the sha the land was recorded against…
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "reviewed");
    // …so a later edit of the same file by the user is never credited to the agent.
    await writeFile(join(work, "app.ts"), `${edited(1)}mine\n`);
    expect(await origins.forRepo("root", work)).toEqual({});
});
