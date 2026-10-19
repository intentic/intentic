import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Rule } from "@intentic/sandbox-contract/schemas/settings";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../../composition.js";
import { gitInit } from "@intentic/base/git";
import { ensureProjectRepo } from "../../../git/remote/project-repo.js";
import { commitRootBaseline, ensureRootRepo } from "../../../git/remote/root-repo.js";
import { createLogger } from "../../../logger.js";
import { createPerfTracker } from "../../../system/resources/perf.js";
import { isolatedAgent } from "../../registry/agents-store.testing.js";
import { noIsolation } from "../../worktrees/isolation.testing.js";
import { repoGitDir, syncRootExcludes } from "../../../workspace/layout/git-layout.js";
import { workspacePaths } from "../../../workspace/workspace.js";
import { createAgentWorktrees, type AgentWorktrees } from "../../worktrees/worktrees.js";
import { contextNoteFor } from "../../../agent/context/conversation-context.js";
import { outsideCheckout } from "../../worktrees/outside-checkout.js";
import { landAgent } from "../land.js";
import { syncBeforeLand } from "../sync.js";
import { versionMainTree, versionProjectFolders } from "../version-landed.js";

// A folder synced in from the owner's computer, end to end as a conversation meets it: the repo the daemon makes for it,
// the checkout cut from it, the folder moving under the conversation while it works, and the land. Before the folder's
// repo was born at boot it was left out of every checkout, so all of this read as nothing to land.

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });
const perf = createPerfTracker(logger);

const PROJECT = "urzednik";

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

// The boot's own order (bootstrap/boot-chain.ts): the workspace repo, the project folder's, then the baseline.
const setup = async (): Promise<{ work: string; folder: string; worktrees: AgentWorktrees }> => {
    const base = await mkdtemp(join(tmpdir(), "intentic-project-land-"));
    tempDirs.push(base);
    const work = join(base, "work");
    const historyRoot = join(base, "history");
    const workspace = workspacePaths(work);
    const folder = join(work, PROJECT);
    await mkdir(join(folder, "docs"), { recursive: true });
    // What file sync had delivered before the sandbox first booted.
    await writeFile(join(folder, "README.md"), "# urzednik\n");
    await writeFile(join(folder, "docs", "plan.md"), "one\ntwo\nthree\n");
    await ensureRootRepo(workspace, historyRoot);
    await ensureProjectRepo(workspace, historyRoot, PROJECT);
    await commitRootBaseline(workspace);
    const worktrees = createAgentWorktrees({
        workspace,
        worktreesRoot: join(historyRoot, "worktrees"),
        historyRoot,
        isolation: noIsolation(work, historyRoot),
        logger,
        perf,
    });
    return { work, folder, worktrees };
};

const servicesOf = (worktrees: AgentWorktrees, rules: readonly Rule[] = []): Services =>
    unstubbed<Services>("services", {
        // SAFETY: versionMainTree reads `rules` alone off the settings; the rest of the document is never touched here.
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => ({ rules }) as never }),
        agentWorktrees: worktrees,
        // No land here owes a version commit, so the remainder leaves nothing out.
        agents: unstubbed<Services["agents"]>("agents", { ids: () => [] }),
        logger,
    });

// What a press of Land does before it writes (land-by-hand.ts): the folder versioned, the branch rebased onto it.
const land = async (worktrees: AgentWorktrees, repos: readonly { repo: string; base: string }[]): ReturnType<typeof landAgent> => {
    await versionProjectFolders(servicesOf(worktrees), [PROJECT]);
    const synced = await syncBeforeLand(worktrees, { id: "c1", title: "write the material", repos }, async () => undefined);
    return landAgent(worktrees, isolatedAgent([...synced]));
};

test("a synced folder is in the conversation's checkout, and what the agent writes there lands", async () => {
    const { folder, worktrees } = await setup();

    const opened = await worktrees.ensure("c1", []);

    expect(opened.repos.map(({ repo }) => repo)).toEqual(["root", PROJECT]);
    const copy = worktrees.worktreeDir("c1", PROJECT);
    expect(await readFile(join(copy, "docs", "plan.md"), "utf8")).toBe("one\ntwo\nthree\n");

    await mkdir(join(copy, "material"), { recursive: true });
    await writeFile(join(copy, "material", "lesson-01.md"), "# Lesson 1\n");
    const outcome = await land(worktrees, opened.repos);

    expect(outcome.landed).toBe(true);
    expect(outcome.conflicts).toBeUndefined();
    expect(await readFile(join(folder, "material", "lesson-01.md"), "utf8")).toBe("# Lesson 1\n");
});

// File sync keeps writing into the folder while the conversation works. Uncommitted, those edits read as the owner's
// work in progress and a land touching the same file was refused as `workspace`, a wall nothing in the sandbox clears.
test("what file sync delivered meanwhile is versioned first, so the land merges with it rather than refusing", async () => {
    const { folder, worktrees } = await setup();
    const opened = await worktrees.ensure("c1", []);
    const copy = worktrees.worktreeDir("c1", PROJECT);

    await writeFile(join(copy, "docs", "plan.md"), "one\ntwo\nthree\nfour, from the agent\n");
    // The owner, on their computer, edits the top of the same file and adds another.
    await writeFile(join(folder, "docs", "plan.md"), "zero, from the owner\none\ntwo\nthree\n");
    await writeFile(join(folder, "notes.md"), "kept\n");
    const outcome = await land(worktrees, opened.repos);

    expect(outcome.landed).toBe(true);
    expect(await readFile(join(folder, "docs", "plan.md"), "utf8")).toBe("zero, from the owner\none\ntwo\nthree\nfour, from the agent\n");
    expect(await readFile(join(folder, "notes.md"), "utf8")).toBe("kept\n");
});

// The folder is a mirror nobody commits, so the owner's version rule is no say over it; every other repo stays their
// review boundary.
test("a turn opening commits the folder's remainder without the version rule, and leaves the workspace's own alone", async () => {
    const { work, folder, worktrees } = await setup();
    await writeFile(join(folder, "notes.md"), "synced\n");
    await writeFile(join(work, "scratchpad.md"), "the owner's own, mid-edit\n");

    expect(await versionMainTree(servicesOf(worktrees), ["root", PROJECT])).toEqual([PROJECT]);

    expect(await sh(folder, "status", "--porcelain")).toBe("");
    expect(await sh(folder, "log", "-1", "--format=%s")).toBe(`Your ${PROJECT} folder as it stands`);
    expect(await sh(work, "status", "--porcelain")).toBe("?? scratchpad.md");
});

test("a conversation that began while the folder's repo was unborn takes it in on its next turn", async () => {
    const base = await mkdtemp(join(tmpdir(), "intentic-project-late-"));
    tempDirs.push(base);
    const work = join(base, "work");
    const historyRoot = join(base, "history");
    const workspace = workspacePaths(work);
    const folder = join(work, PROJECT);
    await ensureRootRepo(workspace, historyRoot);
    // An older sandbox's boot: the folder made a repo and never committed.
    await gitInit(folder, repoGitDir(historyRoot, PROJECT));
    await syncRootExcludes(historyRoot, [PROJECT]);
    await commitRootBaseline(workspace);
    const worktrees = createAgentWorktrees({
        workspace,
        worktreesRoot: join(historyRoot, "worktrees"),
        historyRoot,
        isolation: noIsolation(work, historyRoot),
        logger,
        perf,
    });
    const before = await worktrees.ensure("c1", []);
    expect(before.repos.map(({ repo }) => repo)).toEqual(["root"]);
    // What its agent wrote where the folder should have been: in no checkout, so on no branch.
    await mkdir(join(worktrees.worktreeDir("c1", "root"), PROJECT, "material"), { recursive: true });
    await writeFile(join(worktrees.worktreeDir("c1", "root"), PROJECT, "material", "lesson-01.md"), "# Lesson 1\n");
    await writeFile(join(folder, "README.md"), "# urzednik\n");

    // This sandbox's boot gives the repo its HEAD, and the conversation's next turn composes it.
    expect(await ensureProjectRepo(workspace, historyRoot, PROJECT)).toBe("first commit taken");
    const after = await worktrees.ensure("c1", before.repos);

    expect(after.repos.map(({ repo }) => repo)).toEqual(["root", PROJECT]);
    const copy = worktrees.worktreeDir("c1", PROJECT);
    expect(await readFile(join(copy, "README.md"), "utf8")).toBe("# urzednik\n");
    // The files written into the hole are not lost: they stand in the folder's copy now, as the agent's own work.
    expect(await readFile(join(copy, "material", "lesson-01.md"), "utf8")).toBe("# Lesson 1\n");
    const outcome = await land(worktrees, after.repos);
    expect(outcome.landed).toBe(true);
    expect(await readFile(join(folder, "material", "lesson-01.md"), "utf8")).toBe("# Lesson 1\n");
});

// A conversation narrowed to the workspace's own repo still has the folder in its tree as a plain directory, and a turn
// can write there. The review used to read as an agent that wrote nothing; it names the folder and the count instead.
test("files written where the checkout carries no repo are named on the review, with why", async () => {
    const { worktrees } = await setup();
    const narrowed = await worktrees.ensure("c1", [], undefined, undefined, []);
    expect(narrowed.repos.map(({ repo }) => repo)).toEqual(["root"]);
    const hole = join(worktrees.worktreeDir("c1", "root"), PROJECT, "material");
    await mkdir(hole, { recursive: true });
    await writeFile(join(hole, "lesson-01.md"), "# Lesson 1\n");
    await writeFile(join(hole, "lesson-02.md"), "# Lesson 2\n");

    expect(await outsideCheckout(worktrees, worktrees.mainDir("root"), "c1", narrowed.repos)).toEqual([
        { repo: PROJECT, reason: "not-carried", files: 2 },
    ]);
    // A carried repo is never a hole, whatever its checkout holds.
    const whole = await worktrees.ensure("c2", []);
    await writeFile(join(worktrees.worktreeDir("c2", PROJECT), "new.md"), "carried\n");
    expect(await outsideCheckout(worktrees, worktrees.mainDir("root"), "c2", whole.repos)).toEqual([]);
});

test("the turn is told up front which folders no checkout can carry, and why", async () => {
    const base = await mkdtemp(join(tmpdir(), "intentic-project-note-"));
    tempDirs.push(base);
    const work = join(base, "work");
    const historyRoot = join(base, "history");
    await ensureRootRepo(workspacePaths(work), historyRoot);
    await gitInit(join(work, PROJECT), repoGitDir(historyRoot, PROJECT));
    const services = unstubbed<Services>("services", {
        agents: unstubbed<Services["agents"]>("agents", { entry: () => undefined }),
        workspace: unstubbed<Services["workspace"]>("workspace", { root: work }),
        personas: unstubbed<Services["personas"]>("personas", {}),
        areas: unstubbed<Services["areas"]>("areas", { list: async () => [] }),
    });

    const note = await contextNoteFor(services, "c1");

    expect(note?.title).toBe("Folders outside this checkout");
    expect(note?.text).toContain(`\`${PROJECT}\` has no commit yet, so it is not checked out here.`);

    // Once the folder has a commit there is nothing left to say.
    await ensureProjectRepo(workspacePaths(work), historyRoot, PROJECT);
    expect(await contextNoteFor(services, "c1")).toBeUndefined();
});
