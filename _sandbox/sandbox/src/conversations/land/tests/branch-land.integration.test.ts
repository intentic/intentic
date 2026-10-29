import { createAgentOrigins } from "../origins.js";
import { createExpiryTracker } from "../../registry/expiry.js";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { unstubbed } from "@intentic/testing";
import type { AgentTurn } from "@intentic/sandbox-contract/schemas/agent";
import type { Services } from "../../../composition.js";
import { contextNoteFor, ensureComposedWorktree } from "../../../agent/context/conversation-context.js";
import { createLogger } from "../../../logger.js";
import { createPerfTracker } from "../../../system/resources/perf.js";
import { workspacePaths } from "../../../workspace/workspace.js";
import { beginTurn } from "../../actor/conversation-actors.testing.js";
import { memoryFleet } from "../../registry/agents-registry.testing.js";
import { type IsolatedAgent, isIsolated } from "../../registry/agents-store.js";
import { createBranchCheckouts } from "../../worktrees/branches/branch-checkouts.js";
import { noIsolation } from "../../worktrees/isolation.testing.js";
import { createAgentWorktrees } from "../../worktrees/worktrees.js";
import { branchLinesOf } from "../branch/branch-land.js";
import { branchLandings } from "../../../git/review/branch-landings.js";
import { landAgent } from "../land.js";
import { syncConversation } from "../sync.js";

// A CONVERSATION STARTED FROM A BRANCH (branch-repos.ts, branch-land.ts): its copy of that repo cut from the branch's tip,
// synced onto the branch as it moves, and its land committed onto the branch, while the shared checkout never leaves its
// main line. Changes in any other repo refuse the commit before anything lands. Real git, the real registry and the
// real opening compose, since what is under test is where every commit ends up.

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
const commit = (cwd: string, message: string): Promise<string> => sh(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message);
const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });
const perf = createPerfTracker(logger);
const ID = "c1";
const TITLE = "Fix the login bug";

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

const repoAt = async (dir: string, files: Record<string, string>): Promise<string> => {
    await mkdir(dir, { recursive: true });
    await sh(dir, "init", "-q", "-b", "main");
    for (const [name, text] of Object.entries(files)) {
        await writeFile(join(dir, name), text);
    }
    await sh(dir, "add", "-A");
    await commit(dir, "baseline");
    return sh(dir, "rev-parse", "HEAD");
};

// A workspace on `main` whose `feature` adds feature.ts; nested `libs/ui` also has a `feature` branch.
const setup = async (repo = "root") => {
    const base = await mkdtemp(join(tmpdir(), "intentic-branch-land-"));
    tempDirs.push(base);
    const work = join(base, "work");
    const historyRoot = join(base, "history");
    const mainTip = await repoAt(work, { "app.ts": "a\nb\nc\nd\ne\n", ".gitignore": "libs/\n" });
    await sh(work, "checkout", "-q", "-b", "feature");
    await writeFile(join(work, "feature.ts"), "feature\n");
    await sh(work, "add", "-A");
    await commit(work, "feature work");
    const featureTip = await sh(work, "rev-parse", "HEAD");
    await sh(work, "checkout", "-q", "main");
    const ui = join(work, "libs", "ui");
    const uiTip = await repoAt(ui, { "button.ts": "button\n" });
    await sh(ui, "branch", "feature");
    const workspace = workspacePaths(work);
    const worktrees = createAgentWorktrees({
        workspace,
        worktreesRoot: join(historyRoot, "worktrees"),
        historyRoot,
        isolation: noIsolation(work, historyRoot),
        logger,
        perf,
    });
    const branchCheckouts = createBranchCheckouts({ historyRoot, worktrees, logger });
    const { agents, conversations } = memoryFleet();
    await beginTurn(conversations, { conversationId: ID, isolated: true, prompt: TITLE, title: TITLE, profile: { agent: "claude", harness: "native" } }, 1_000);
    // What the opening compose and its note read, and nothing else: anything more would throw by name.
    const services = unstubbed<Services>("services", {
        agents,
        conversations,
        agentWorktrees: worktrees,
        branchCheckouts,
        workspace,
        areas: unstubbed<Services["areas"]>("areas", { list: async () => [] }),
    });
    const opening: AgentTurn = { prompt: TITLE, conversationId: ID, isolated: true, fromBranch: { repo, branch: "feature" } };
    const open = async () => ensureComposedWorktree(services, opening, ID, undefined, false);
    const entry = (): IsolatedAgent => {
        const found = agents.entry(ID);
        if (found === undefined || !isIsolated(found)) {
            throw new Error("the conversation has no checkout");
        }
        return found;
    };
    const land = async (mode: "check" | "merge" | "measure" = "check") => {
        const current = entry();
        const outcome = await landAgent(worktrees, current, mode, "outstanding", undefined, await branchLinesOf(services, current.placement));
        await agents.recordLanded(ID, outcome);
        return outcome;
    };
    // The branch moved by someone else (a push from another copy, a fetch): a commit on it made away from every checkout.
    const moveFeature = async (file: string, text: string): Promise<string> => {
        const aside = join(base, `aside-${file.replaceAll("/", "_")}`);
        await sh(work, "worktree", "add", "-q", "--detach", aside, "feature");
        await writeFile(join(aside, file), text);
        await sh(aside, "add", "-A");
        await commit(aside, `elsewhere: ${file}`);
        const moved = await sh(aside, "rev-parse", "HEAD");
        await sh(work, "update-ref", "refs/heads/feature", moved);
        await sh(work, "worktree", "remove", "--force", aside);
        return moved;
    };
    return { work, ui, mainTip, featureTip, uiTip, worktrees, branchCheckouts, agents, services, open, entry, land, moveFeature };
};

test("opening from a branch cuts that repo's copy from the branch's tip, every other repo from the main line, and latches it", async () => {
    const { work, mainTip, featureTip, uiTip, worktrees, agents, services, open, entry } = await setup();
    const worktree = await open();
    expect(worktree.repos).toEqual([
        { repo: "root", base: featureTip },
        { repo: "libs/ui", base: uiTip },
    ]);
    expect(await readFile(join(worktree.cwd, "feature.ts"), "utf8")).toBe("feature\n");
    expect(await sh(worktrees.worktreeDir(ID, "libs/ui"), "rev-parse", "HEAD")).toBe(uiTip);
    expect(entry().placement.branches).toEqual([{ repo: "root", branch: "feature" }]);
    expect(agents.get(ID)?.branches).toEqual([{ repo: "root", branch: "feature" }]);
    // The model is told where its work goes.
    expect((await contextNoteFor(services, ID))?.text).toContain("started from branch `feature`; your finished work lands there as uncommitted changes");
    // The shared checkout never moved.
    expect(await sh(work, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(await sh(work, "rev-parse", "HEAD")).toBe(mainTip);
});

test("a land leaves the branch repo's work uncommitted and every shared repository untouched", async () => {
    const { work, ui, mainTip, featureTip, branchCheckouts, agents, open, land } = await setup();
    const worktree = await open();
    await writeFile(join(worktree.cwd, "agent.ts"), "the agent's work\n");
    const outcome = await land();
    expect(outcome.landed).toBe(true);
    expect(outcome.conflicts ?? []).toEqual([]);
    expect(await sh(work, "rev-parse", "feature")).toBe(featureTip);
    const checkout = await branchCheckouts.refresh("root", "feature");
    expect(await readFile(join(checkout, "agent.ts"), "utf8")).toBe("the agent's work\n");
    expect(await sh(checkout, "diff", "--cached", "--name-only")).toBe("");
    expect(await sh(checkout, "status", "--porcelain")).toBe("?? agent.ts");
    expect((await branchLandings(checkout, work)).commits).toEqual([]);
    const origins = createAgentOrigins({ agents, logger, expiry: createExpiryTracker() });
    expect(await origins.forRepo("root", work)).toEqual({});
    expect(await origins.forRepo("root", checkout, undefined, { repo: "root", branch: "feature" })).toEqual({ "agent.ts": [ID] });
    expect(await origins.forRepo("root", work)).toEqual({});
    // The shared tree's root repo took nothing and never moved.
    expect(await sh(work, "rev-parse", "HEAD")).toBe(mainTip);
    await expect(readFile(join(work, "agent.ts"), "utf8")).rejects.toThrow();
    expect(await sh(work, "status", "--porcelain")).toBe("");
    expect(await readFile(join(ui, "button.ts"), "utf8")).toBe("button\n");
    expect(await sh(ui, "status", "--porcelain")).toBe("");
});

test.each(["check", "merge", "measure"] as const)("%s refuses a nested branch session's root edits before any repository is written", async (mode) => {
    const { work, ui, mainTip, uiTip, worktrees, open, land } = await setup("libs/ui");
    const worktree = await open();
    await writeFile(join(worktree.cwd, "app.ts"), "root edit\n");
    await writeFile(join(worktrees.worktreeDir(ID, "libs/ui"), "button.ts"), "branch edit\n");
    await expect(land(mode)).rejects.toThrow("Changes in root have no branch destination. Nothing was landed");
    expect(await sh(work, "rev-parse", "HEAD")).toBe(mainTip);
    expect(await sh(ui, "rev-parse", "feature")).toBe(uiTip);
    expect(await sh(work, "status", "--porcelain")).toBe("");
    expect(await sh(ui, "status", "--porcelain")).toBe("");
    expect(await readFile(join(worktree.cwd, "app.ts"), "utf8")).toBe("root edit\n");
    expect(await readFile(join(worktrees.worktreeDir(ID, "libs/ui"), "button.ts"), "utf8")).toBe("branch edit\n");
});

test("a root-only edit in a nested branch session is refused, and the branch can be committed after the root edit is undone", async () => {
    const { work, ui, uiTip, worktrees, branchCheckouts, open, land } = await setup("libs/ui");
    const worktree = await open();
    const original = await readFile(join(worktree.cwd, "app.ts"), "utf8");
    await writeFile(join(worktree.cwd, "app.ts"), "test edit outside the selected repo\n");
    await expect(land()).rejects.toThrow("Changes in root have no branch destination");
    await writeFile(join(worktree.cwd, "app.ts"), original);
    await writeFile(join(worktrees.worktreeDir(ID, "libs/ui"), "button.ts"), "branch edit\n");
    expect((await land()).landed).toBe(true);
    expect(await sh(ui, "rev-parse", "feature")).toBe(uiTip);
    expect(await readFile(join(branchCheckouts.checkoutDir("libs/ui", "feature"), "button.ts"), "utf8")).toBe("branch edit\n");
    expect(await sh(work, "status", "--porcelain")).toBe("");
    expect(await sh(ui, "status", "--porcelain")).toBe("");
});

test("a root branch session refuses changes in another repository without committing its own work", async () => {
    const { work, ui, featureTip, worktrees, open, land } = await setup();
    const worktree = await open();
    await writeFile(join(worktree.cwd, "agent.ts"), "branch edit\n");
    await writeFile(join(worktrees.worktreeDir(ID, "libs/ui"), "button.ts"), "other repo edit\n");
    await expect(land()).rejects.toThrow("Changes in libs/ui have no branch destination");
    expect(await sh(work, "rev-parse", "feature")).toBe(featureTip);
    expect(await sh(work, "status", "--porcelain")).toBe("");
    expect(await sh(ui, "status", "--porcelain")).toBe("");
});

test("a branch that moved on is synced onto, and the next land stays uncommitted on top of it", async () => {
    const { work, worktrees, services, branchCheckouts, open, entry, land, moveFeature } = await setup();
    const worktree = await open();
    await writeFile(join(worktree.cwd, "agent.ts"), "first\n");
    await land();
    const checkout = branchCheckouts.checkoutDir("root", "feature");
    await sh(checkout, "add", "-A");
    await sh(checkout, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "test: owner commits first landing");
    const moved = await moveFeature("other.ts", "from elsewhere\n");
    const lines = await branchLinesOf(services, entry().placement);
    const recorded = entry().placement.repos;
    const synced = await syncConversation(
        worktrees,
        ID,
        recorded.map(({ repo, base, landedTip }) => ({ repo, base, landedTip, line: lines.get(repo)?.dir })),
        TITLE,
    );
    expect(synced.map(({ repo, onto, blocked }) => ({ repo, onto, blocked }))).toEqual([{ repo: "root", onto: moved, blocked: undefined }]);
    expect(await readFile(join(worktree.cwd, "other.ts"), "utf8")).toBe("from elsewhere\n");
    // What it had landed is on the branch already, so it is not carried twice.
    expect(await sh(worktree.cwd, "rev-parse", "HEAD")).toBe(moved);
    await services.agents.recordWorktree(
        ID,
        recorded.map((composed) => (composed.repo === "root" ? { ...composed, base: moved } : composed)),
    );
    await writeFile(join(worktree.cwd, "agent.ts"), "first, then second\n");
    const outcome = await land();
    expect(outcome.landed).toBe(true);
    expect(await sh(work, "rev-parse", "feature")).toBe(moved);
    expect(await readFile(join(checkout, "agent.ts"), "utf8")).toBe("first, then second\n");
    expect(await sh(work, "show", "feature:other.ts")).toBe("from elsewhere");
});

test("a conflicting branch land leaves editable markers without moving its branch", async () => {
    const { work, branchCheckouts, open, land, moveFeature } = await setup();
    const worktree = await open();
    await writeFile(join(worktree.cwd, "app.ts"), "a\nb\nAGENT\nd\ne\n");
    const moved = await moveFeature("app.ts", "a\nb\nBRANCH\nd\ne\n");
    const checked = await land("check");
    expect(checked.landed).toBe(false);
    expect(checked.conflicts).toEqual([{ repo: "root", paths: [{ path: "app.ts", reason: "diverged" }], clean: 0, mainBranch: "feature" }]);
    // A merge leaves markers for the owner to resolve in the branch checkout.
    const merged = await land("merge");
    expect(merged.landed).toBe(true);
    expect(merged.resolving).toEqual([{ repo: "root", paths: ["app.ts"] }]);
    expect(await sh(work, "rev-parse", "feature")).toBe(moved);
    const checkout = branchCheckouts.checkoutDir("root", "feature");
    expect(await sh(checkout, "status", "--porcelain")).toBe("M app.ts");
    expect(await readFile(join(checkout, "app.ts"), "utf8")).toContain("<<<<<<<");
    expect(await sh(work, "status", "--porcelain")).toBe("");
});
