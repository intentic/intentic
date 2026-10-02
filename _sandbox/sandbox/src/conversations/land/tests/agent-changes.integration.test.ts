import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { AddedDependencies } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../../composition.js";
import { discardPaths } from "../../../git/changes/changes-index.js";
import { ensureRootRepo } from "../../../git/remote/root-repo.js";
import { createLogger } from "../../../logger.js";
import { createPerfTracker } from "../../../system/resources/perf.js";
import { isolatedAgent, noIsolation } from "../../../testing.js";
import { workspacePaths } from "../../../workspace/workspace.js";
import { agentRepoReview, presentInMain } from "../agent-changes.js";
import { landAgent } from "../land.js";
import { reviewOf } from "../review.js";
import { createAgentWorktrees, type AgentWorktrees, type ConversationWorktree } from "../../worktrees/worktrees.js";

// Reviews land state against real git: accept moves main's HEAD, discard moves nothing, and the agent branch is
// untouched by either, so no stub can stand in for these states.

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

// Writes each file under `root`, making the directories it needs.
const writeTree = async (root: string, files: Readonly<Record<string, string>>): Promise<void> => {
    for (const [path, content] of Object.entries(files)) {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), content);
    }
};

// `baseline` joins the two files every suite here starts from, committed before the conversation's copy is cut.
const setup = async (
    baseline: Readonly<Record<string, string>> = {},
): Promise<{ work: string; worktrees: AgentWorktrees; conversation: ConversationWorktree }> => {
    const base = await mkdtemp(join(tmpdir(), "intentic-present-"));
    tempDirs.push(base);
    const work = join(base, "work");
    const historyRoot = join(base, "history");
    const workspace = workspacePaths(work);
    await mkdir(work, { recursive: true });
    await ensureRootRepo(workspace, historyRoot);
    await writeFile(join(work, "app.ts"), `${LINES.join("\n")}\n`);
    await writeFile(join(work, "other.ts"), `${LINES.join("\n")}\n`);
    await writeTree(work, baseline);
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

// Runs both review steps together: the rows, and how each stands against the main tree.
const review = async (
    worktrees: AgentWorktrees,
    entry: ReturnType<typeof isolatedAgent>,
): Promise<{ rows: string[]; landed: string[]; absorbed: string[] }> => {
    const composed = entry.placement.repos[0];
    if (composed === undefined) {
        throw new Error("no repo in the composition");
    }
    const { changes } = await agentRepoReview(worktrees, entry, composed);
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
    // An untracked add beside a tracked edit: `git diff` cannot see it, since it is in neither commit nor index.
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

    // Turn two rewrites but does not land; presence must go by content, not name, since main has a same-named file.
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

    // Uncommitted in the agent checkout; the branch tip reflects none of it.
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

    // An unreadable branch must answer as though it never looked: nothing landed, nothing absorbed.
    const present = await presentInMain(
        worktrees,
        { ...entry, placement: { ...entry.placement, branch: "agent/does-not-exist" } },
        entry.placement.repos[0]!,
        ["app.ts"],
    );
    expect([...present.absorbed]).toEqual([]);
    expect([...present.inWorkspace]).toEqual([]);
});

test("a rebase after the accept leaves the answer where it was: nothing outstanding, nothing listed", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), edited(1));
    const landed = await landAgent(worktrees, isolatedAgent(conversation.repos));

    await sh(work, "add", "-A");
    await commit(work, "take it");
    // Simulates the pre-turn sync's rebase onto main; the review must not change for any file because of it.
    const head = await sh(work, "rev-parse", "HEAD");
    await sh(conversation.cwd, "rebase", "--onto", head, landed.repos[0]?.landedTip ?? "HEAD").catch(() => sh(conversation.cwd, "rebase", "--abort"));

    const state = await review(worktrees, isolatedAgent(landed.repos));
    expect(state.rows).toEqual([]);
});

// The review as the route serves it, row by row: which paths it lists and which of them it calls landed.
const served = async (worktrees: AgentWorktrees, entry: ReturnType<typeof isolatedAgent>): Promise<{ rows: string[]; landed: string[] }> => {
    const deps = { agentWorktrees: worktrees, agents: unstubbed<Services["agents"]>("agents", {}), logger };
    const changes = (await reviewOf(deps, entry)).repos.flatMap((row) => row.changes);
    return {
        rows: changes.map((change) => change.path).sort(),
        landed: changes
            .filter((change) => change.landed)
            .map((change) => change.path)
            .sort(),
    };
};

// Several lines edited at once, so a later edit in main builds on the agent's edit rather than undoing it.
const editedAlso = (...lines: number[]): string =>
    `${LINES.map((text, index) => (lines.includes(index + 1) ? `${text} EDITED` : text)).join("\n")}\n`;

test("a landed file main has committed further since is still landed: no Land now for a land that carries nothing", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), edited(1));
    await writeFile(join(conversation.cwd, "other.ts"), edited(2));
    const landed = await landAgent(worktrees, isolatedAgent(conversation.repos));
    await sh(work, "add", "-A");
    await commit(work, "take it");
    // Another agent's land, committed on top: app.ts in main is no longer the agent's copy, nor is it outstanding.
    await writeFile(join(work, "app.ts"), editedAlso(1, 5));
    await sh(work, "add", "-A");
    await commit(work, "another agent's work");

    const entry = isolatedAgent(landed.repos);
    expect(await served(worktrees, entry)).toEqual({ rows: ["app.ts"], landed: ["app.ts"] });
    // What the review says is what a land does: nothing to carry.
    expect((await landAgent(worktrees, entry)).changed).toBe(false);
});

test("a landed file the owner edits further without committing is still landed", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), edited(1));
    const landed = await landAgent(worktrees, isolatedAgent(conversation.repos));
    await writeFile(join(work, "app.ts"), editedAlso(1, 5));

    expect(await served(worktrees, isolatedAgent(landed.repos))).toEqual({ rows: ["app.ts"], landed: ["app.ts"] });
});

test("landed work discarded from the tree stays outstanding in the served review, which keeps its Land again", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), edited(1));
    const landed = await landAgent(worktrees, isolatedAgent(conversation.repos));
    await discardPaths(work, undefined);

    expect(await served(worktrees, isolatedAgent(landed.repos))).toEqual({ rows: ["app.ts"], landed: [] });
});

test("main moving on does not hide what the agent wrote after its land", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), edited(1));
    const landed = await landAgent(worktrees, isolatedAgent(conversation.repos));
    await sh(work, "add", "-A");
    await commit(work, "take it");
    await writeFile(join(work, "app.ts"), editedAlso(1, 5));
    await sh(work, "add", "-A");
    await commit(work, "another agent's work");
    // Turn two edits the same file again and does not land it.
    await writeFile(join(conversation.cwd, "app.ts"), editedAlso(1, 9));
    await sh(conversation.cwd, "add", "-A");
    await commit(conversation.cwd, "turn two");

    expect(await served(worktrees, isolatedAgent(landed.repos))).toEqual({ rows: ["app.ts"], landed: [] });
});

// The review is where a dependency the work adds is approved, so what it names must be exactly what the project takes
// on: names, not versions, per manifest, read from the copy's own files (uncommitted ones too), and nothing claimed from
// a manifest that cannot be read.
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const DEPENDENCY_BASELINE = {
    "package.json": json({ name: "app", dependencies: { hono: "^4.0.0" }, devDependencies: { typescript: "^5.0.0" } }),
    "requirements.txt": "Flask==3.0\n",
};

// The rows and the dependency reading of the one repo, as the review route asks for them.
const addedIn = async (worktrees: AgentWorktrees, entry: ReturnType<typeof isolatedAgent>): Promise<AddedDependencies[]> => {
    const composed = entry.placement.repos[0];
    if (composed === undefined) {
        throw new Error("no repo in the composition");
    }
    const read = await agentRepoReview(worktrees, entry, composed);
    return read.addedDependencies(read.changes);
};

test("a live copy's new dependencies are the names each manifest declares now and did not at the anchor", async () => {
    const { worktrees, conversation } = await setup(DEPENDENCY_BASELINE);
    await writeTree(conversation.cwd, {
        // A version bump of hono and typescript moved to another block are not new; the three others are.
        "package.json": json({
            name: "app",
            dependencies: { hono: "^4.6.0", remotion: "^4.0.0" },
            devDependencies: { "@remotion/cli": "^4.0.0" },
            peerDependencies: { react: "*", typescript: "^5.0.0" },
        }),
        "video/package.json": json({ name: "video", optionalDependencies: { sharp: "^0.33.0" } }),
        // Unparseable: left out rather than guessed at, and never a reason the rest goes unread.
        "broken/package.json": "{ not json",
        // A manifest that gains nothing gets no entry.
        "tools/package.json": json({ name: "tools" }),
        // `flask` is Flask re-pinned; an option line and a bare URL name no package.
        "requirements.txt": "flask==3.1  # re-pinned\n-r base.txt\nrequests[socks]>=2.31 ; python_version > '3.8'\ngit+https://example.com/x.git\n",
        "pyproject.toml":
            '[project]\nname = "tool"\ndependencies = ["httpx>=0.27", "Pydantic_Core"]\n\n[project.optional-dependencies]\ndev = ["pytest"]\n',
    });

    expect(await addedIn(worktrees, isolatedAgent(conversation.repos))).toEqual([
        { path: "package.json", added: ["@remotion/cli", "react", "remotion"] },
        { path: "pyproject.toml", added: ["httpx", "Pydantic_Core", "pytest"] },
        { path: "requirements.txt", added: ["requests"] },
        { path: "video/package.json", added: ["sharp"] },
    ]);
});

test("a retired copy's new dependencies are read off its branch, the same answer the checkout gave", async () => {
    const { worktrees, conversation } = await setup(DEPENDENCY_BASELINE);
    await writeTree(conversation.cwd, { "package.json": json({ name: "app", dependencies: { hono: "^4.0.0", zod: "^4.0.0" } }) });
    await worktrees.retire("c1", conversation.repos, "add zod");

    expect(await addedIn(worktrees, isolatedAgent(conversation.repos))).toEqual([{ path: "package.json", added: ["zod"] }]);
});

test("the review's row carries the new dependencies, and says nothing of them when there are none", async () => {
    const { worktrees, conversation } = await setup(DEPENDENCY_BASELINE);
    const deps = { agentWorktrees: worktrees, agents: unstubbed<Services["agents"]>("agents", {}), logger };
    await writeFile(join(conversation.cwd, "app.ts"), edited(1));

    const quiet = await reviewOf(deps, isolatedAgent(conversation.repos));
    expect(quiet.repos.map((row) => Object.keys(row).sort())).toEqual([["branch", "changes", "modules", "repo"]]);

    await writeTree(conversation.cwd, { "package.json": json({ name: "app", dependencies: { hono: "^4.0.0", remotion: "^4.0.0" } }) });
    const adding = await reviewOf(deps, isolatedAgent(conversation.repos));
    expect(adding.repos[0]?.addedDependencies).toEqual([{ path: "package.json", added: ["remotion"] }]);
});
