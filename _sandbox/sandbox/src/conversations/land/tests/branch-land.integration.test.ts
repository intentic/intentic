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
// main line and every other repo of the conversation works as any conversation's does. Real git, the real registry and
// the real opening compose, since what is under test is where every commit ends up.

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

// A workspace on `main` whose `feature` branch adds feature.ts, with a nested repo `libs/ui` that only has its main line.
const setup = async () => {
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
    const opening: AgentTurn = { prompt: TITLE, conversationId: ID, isolated: true, fromBranch: { repo: "root", branch: "feature" } };
    const open = async () => ensureComposedWorktree(services, opening, ID, undefined, false);
    const entry = (): IsolatedAgent => {
        const found = agents.entry(ID);
        if (found === undefined || !isIsolated(found)) {
            throw new Error("the conversation has no checkout");
        }
        return found;
    };
    const land = async (mode: "check" | "merge" = "check") => {
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
    expect((await contextNoteFor(services, ID))?.text).toContain("started from branch `feature`; your finished work is committed onto `feature`, not the main line");
    // The shared checkout never moved.
    expect(await sh(work, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(await sh(work, "rev-parse", "HEAD")).toBe(mainTip);
});

test("a land commits the branch repo's work onto the branch, and the other repo's into the shared tree as any land does", async () => {
    const { work, ui, mainTip, featureTip, worktrees, branchCheckouts, open, land } = await setup();
    const worktree = await open();
    await writeFile(join(worktree.cwd, "agent.ts"), "the agent's work\n");
    await writeFile(join(worktrees.worktreeDir(ID, "libs/ui"), "button.ts"), "button, fixed\n");
    const outcome = await land();
    expect(outcome.landed).toBe(true);
    expect(outcome.conflicts ?? []).toEqual([]);
    // The branch moved by one commit carrying the work, named and trailed like the conversation's own commits.
    expect(await sh(work, "rev-parse", "feature~1")).toBe(featureTip);
    expect(await sh(work, "log", "-1", "--format=%s", "feature")).toBe(`Agent: ${TITLE}`);
    expect(await sh(work, "log", "-1", "--format=%B", "feature")).toContain(ID);
    expect(await sh(work, "show", "feature:agent.ts")).toBe("the agent's work");
    const review = await branchLandings(await branchCheckouts.refresh("root", "feature"), work);
    expect(review.commits.map(({ agent, sha, subject }) => ({ agent, sha, subject }))).toEqual([
        { agent: ID, sha: await sh(work, "rev-parse", "feature"), subject: `Agent: ${TITLE}` },
    ]);
    // The shared tree's root repo took nothing and never moved.
    expect(await sh(work, "rev-parse", "HEAD")).toBe(mainTip);
    await expect(readFile(join(work, "agent.ts"), "utf8")).rejects.toThrow();
    expect(await sh(work, "status", "--porcelain")).toBe("");
    // The nested repo, on the main line, landed as every land does: uncommitted in the shared tree.
    expect(await readFile(join(ui, "button.ts"), "utf8")).toBe("button, fixed\n");
    expect(await sh(ui, "status", "--porcelain")).toBe("M button.ts");
});

test("a branch that moved on is synced onto, and the next land commits on top of it", async () => {
    const { work, worktrees, services, open, entry, land, moveFeature } = await setup();
    const worktree = await open();
    await writeFile(join(worktree.cwd, "agent.ts"), "first\n");
    await land();
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
    expect(await sh(work, "rev-parse", "feature~1")).toBe(moved);
    expect(await sh(work, "show", "feature:agent.ts")).toBe("first, then second");
    expect(await sh(work, "show", "feature:other.ts")).toBe("from elsewhere");
});

test("a land that clashes with the branch is its conflict, naming the branch, and leaves the branch and its checkout as they were", async () => {
    const { work, branchCheckouts, open, land, moveFeature } = await setup();
    const worktree = await open();
    await writeFile(join(worktree.cwd, "app.ts"), "a\nb\nAGENT\nd\ne\n");
    const moved = await moveFeature("app.ts", "a\nb\nBRANCH\nd\ne\n");
    const checked = await land("check");
    expect(checked.landed).toBe(false);
    expect(checked.conflicts).toEqual([{ repo: "root", paths: [{ path: "app.ts", reason: "diverged" }], clean: 0, mainBranch: "feature" }]);
    // A merge would leave markers nobody resolves in a checkout nobody edits: undone, and the same conflict.
    const merged = await land("merge");
    expect(merged.landed).toBe(false);
    expect(merged.conflicts?.map(({ repo, mainBranch, paths }) => ({ repo, mainBranch, paths: paths.map(({ path }) => path) }))).toEqual([
        { repo: "root", mainBranch: "feature", paths: ["app.ts"] },
    ]);
    expect(await sh(work, "rev-parse", "feature")).toBe(moved);
    const checkout = branchCheckouts.checkoutDir("root", "feature");
    expect(await sh(checkout, "status", "--porcelain")).toBe("");
    expect(await readFile(join(checkout, "app.ts"), "utf8")).toBe("a\nb\nBRANCH\nd\ne\n");
    expect(await sh(work, "status", "--porcelain")).toBe("");
});
