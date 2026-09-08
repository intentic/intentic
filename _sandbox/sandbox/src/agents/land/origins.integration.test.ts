import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { afterEach, expect, test } from "vitest";
import { isolatedAgent, noIsolation } from "../../testing.js";
import { ensureRootRepo } from "../../git/remote/root-repo.js";
import { createLogger } from "../../logger.js";
import { createPerfTracker } from "../../platform/resources/perf.js";
import { workspacePaths } from "../../workspace/workspace.js";
import type { AgentsRegistry } from "../registry/agents-registry.js";
import type { PersistedAgent } from "../registry/agents-store.js";
import { createExpiryTracker } from "../registry/expiry.js";
import { landAgent } from "./land.js";
import { createAgentOrigins } from "./origins.js";
import { createAgentWorktrees, type AgentWorktrees, type ConversationWorktree } from "../worktrees/worktrees.js";

// Attribution derives from landed shas, so tests run against a real land into a real main tree. The registry is stubbed
// to the three methods origins touches (ids/entry/markLandingAbsorbed).

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
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
    const base = await mkdtemp(join(tmpdir(), "intentic-origins-"));
    tempDirs.push(base);
    const work = join(base, "work");
    const historyRoot = join(base, "history");
    const workspace = workspacePaths(work);
    await mkdir(work, { recursive: true });
    await ensureRootRepo(workspace, historyRoot);
    // Long enough that two agents can edit far-apart regions and both patches still apply.
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

// Only ids(), entry() and markLandingAbsorbed() run; the mark mutates the row in place under the real guard, so tests
// exercise restart-survival too (a fresh instance reads no git for an absorbed landing).
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

// Origins over a stub registry and a fresh shared-expiry tracker; the same `git` feeds both readers, so a counting
// runner sees every spawn.
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
    // Land is context-based: a second patch applies over existing uncommitted work if hunks don't overlap.
    await writeFile(join(second.cwd, "app.ts"), edited(12));
    const later = await landAgent(worktrees, isolatedAgent(second.repos, { id: "c2" }));

    const agents = registryOf(isolatedAgent(first.repos), isolatedAgent(later.repos, { id: "c2" }));
    expect((await originsOf(agents).forRepo("root", work))[`app.ts`]).toEqual(["c2", "c1"]);
});

test("committing one agent's work leaves another agent's landed files attributed", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), edited(1));
    const first = await landAgent(worktrees, isolatedAgent(conversation.repos));
    const second = await worktrees.ensure("c2", []);
    await writeFile(join(second.cwd, "other.ts"), "c2 was here\n");
    const later = await landAgent(worktrees, isolatedAgent(second.repos, { id: "c2" }));

    await sh(work, "add", "other.ts");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "reviewed c2");

    // HEAD moves, but only the committed path retires; a repo-wide expiry would blank both.
    const origins = originsOf(registryOf(isolatedAgent(first.repos), isolatedAgent(later.repos, { id: "c2" })));
    expect(await origins.forRepo("root", work)).toEqual({ "app.ts": ["c1"] });
});

// `--name-only` names a rename only at its destination (land.ts DeltaChange): the delete was unattributed, so the
// panel's origin filter hid the row and 'Stage all' left the deletion for the user to find by hand.
test("a rename credits BOTH paths to the agent: the deletion is its work as much as the addition", async () => {
    const { work, worktrees, conversation } = await setup();
    // Moved verbatim, so git scores it a 100% rename: the case that collapses to one path.
    await rm(join(conversation.cwd, "app.ts"));
    await mkdir(join(conversation.cwd, "moved"), { recursive: true });
    await writeFile(join(conversation.cwd, "moved/app.ts"), `${LINES.join("\n")}\n`);
    const landed = await landAgent(worktrees, isolatedAgent(conversation.repos));

    // The land itself gets this right: both halves are in the tree; the bug is only in attribution.
    expect(await sh(work, "status", "--porcelain")).toContain("app.ts");

    const origins = originsOf(registryOf(isolatedAgent(landed.repos)));
    expect(await origins.forRepo("root", work)).toEqual({ "app.ts": ["c1"], "moved/app.ts": ["c1"] });
});

// Omitting `-M` does not turn rename detection off: git has defaulted diff.renames to true since 2.9, so the source
// name kept being claimed on a path that no longer exists.
test("committing a rename of a landed path retires BOTH of its names", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), edited(1));
    const landed = await landAgent(worktrees, isolatedAgent(conversation.repos));

    await sh(work, "mv", "app.ts", "renamed.ts");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "reviewed and renamed");

    const origins = originsOf(registryOf(isolatedAgent(landed.repos)));
    expect(await origins.forRepo("root", work)).toEqual({});
});

test("identify names an ARCHIVED agent: the roster the client mirrors no longer carries it", async () => {
    // Archiving drops an agent from the roster but doesn't commit its landed lines; `entry` still covers it.
    const archived = { ...isolatedAgent([], { id: "c1" }), archivedAt: 1 };
    const untitled = { ...isolatedAgent([], { id: "c2" }) };
    delete untitled.title;
    const origins = originsOf(registryOf(archived, untitled));
    expect(origins.identify(["c1", "c2", "gone"])).toEqual({
        c1: { provider: "claude", title: "fix the thing" },
        // No title means the key is absent, not empty; an id with no entry left is omitted entirely.
        c2: { provider: "claude" },
    });
});

test("a re-land after a rebase claims only the new delta, not the main-line commits the rebase pulled in", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), edited(1));
    const first = await landAgent(worktrees, isolatedAgent(conversation.repos));
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "reviewed app.ts");
    const reviewed = await sh(work, "rev-parse", "HEAD");

    // Rebasing makes the branch CONTAIN the user's commit before landing a second, unrelated file.
    await sh(conversation.cwd, "-c", "user.name=t", "-c", "user.email=t@t", "rebase", reviewed);
    await writeFile(join(conversation.cwd, "other.ts"), "c1 was here\n");
    const second = await landAgent(worktrees, isolatedAgent(first.repos));

    // From the frozen base this would also claim app.ts; landedHead lands past its commit, so expiry never retires it.
    const origins = originsOf(registryOf(isolatedAgent(second.repos)));
    expect(await origins.forRepo("root", work)).toEqual({ "other.ts": ["c1"] });
});

test("a re-land WITHOUT a rebase drops the delta the user committed in between", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), edited(1));
    const first = await landAgent(worktrees, isolatedAgent(conversation.repos));
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "reviewed app.ts");

    // Ordinary, not the exception: a rebase runs only at turn start, so the merge-base stays behind the commit.
    await writeFile(join(conversation.cwd, "other.ts"), "c1 was here\n");
    const second = await landAgent(worktrees, isolatedAgent(first.repos));

    // Caught by the applied-paths intersection, not expiry: app.ts was never in this land's own span.
    const origins = originsOf(registryOf(isolatedAgent(second.repos)));
    expect(await origins.forRepo("root", work)).toEqual({ "other.ts": ["c1"] });

    await writeFile(join(work, "app.ts"), `${edited(1)}later work\n`);
    expect(await origins.forRepo("root", work)).toEqual({ "other.ts": ["c1"] });
});

test("a path the user committed BEFORE the land stays credited: only commits after it retire the claim", async () => {
    const { work, worktrees, conversation } = await setup();
    // Main moves on the very file the agent edits, before the worktree branched, so the merge-base sits behind it.
    await writeFile(join(work, "app.ts"), edited(12));
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "user edits the last line");

    await writeFile(join(conversation.cwd, "app.ts"), edited(1));
    const landed = await landAgent(worktrees, isolatedAgent(conversation.repos));

    // Not folded into the merge-base: that would read the user's earlier commit as absorbing the agent's own lines.
    const origins = originsOf(registryOf(isolatedAgent(landed.repos)));
    expect(await origins.forRepo("root", work)).toEqual({ "app.ts": ["c1"] });
});

// Records every git command a scan issues, so the tests below can assert what a scan does NOT read: the whole reason
// this file caches at all.
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

    // One-way door: absorption is recorded on the entry, so the discovering scan is the last to spend anything.
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "reviewed");
    expect(await origins.forRepo("root", work)).toEqual({});
    expect(entry.repos[0]?.absorbed).toBe(1);

    calls.length = 0;
    expect(await origins.forRepo("root", work)).toEqual({});
    // Dropped before the HEAD read, so an archived agent's already-shipped work costs the panel nothing.
    expect(calls).toEqual([]);

    // The mark persists on the entry, so a fresh instance (a restart) starts already knowing.
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

    await writeFile(join(work, "unrelated.ts"), "user work\n");
    await sh(work, "add", "unrelated.ts");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "user commits their own file");

    calls.length = 0;
    expect(await origins.forRepo("root", work)).toEqual({ "app.ts": ["c1"] });
    expect(calls.filter((args) => args[0] === "merge-base")).toEqual([]);
});

// A superseded head's cache entry is replaced, not accumulated, so the caches stay flat as HEAD advances; a retired
// landing drops its own entries entirely.
test("advancing HEAD replaces the expiry entry: the caches do not grow with the commit count", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), edited(1));
    const landed = await landAgent(worktrees, isolatedAgent(conversation.repos));

    const expiry = createExpiryTracker();
    const origins = createAgentOrigins({ agents: registryOf(isolatedAgent(landed.repos)), logger, expiry });
    expect(await origins.forRepo("root", work)).toEqual({ "app.ts": ["c1"] });
    const { pathCharacters: _content, ...settled } = origins.metrics();

    for (let round = 0; round < 3; round += 1) {
        await writeFile(join(work, "unrelated.ts"), `user work ${round}\n`);
        await sh(work, "add", "unrelated.ts");
        await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", `user commit ${round}`);
        expect(await origins.forRepo("root", work)).toEqual({ "app.ts": ["c1"] });
    }
    // Same cardinalities as the first scan: nothing accumulates per head move, though tracked content can grow.
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

    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "reviewed");
    await writeFile(join(work, "app.ts"), `${edited(1)}mine\n`);
    expect(await origins.forRepo("root", work)).toEqual({});
});

// A deletion is a row like any other: `--name-only` names a deleted path exactly as it names an added one.
test("a file the agent DELETED is credited to the agent", async () => {
    const { work, worktrees, conversation } = await setup();
    await rm(join(conversation.cwd, "other.ts"));
    const landed = await landAgent(worktrees, isolatedAgent(conversation.repos));
    expect(await sh(work, "status", "--porcelain")).toContain("D other.ts");
    const origins = originsOf(registryOf(isolatedAgent(landed.repos)));
    expect(await origins.forRepo("root", work)).toEqual({ "other.ts": ["c1"] });
});
