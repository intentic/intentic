import { historySlice } from "../../history/history-slice.js";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitView } from "@intentic/sandbox-contract/schemas/git/git-view";
import { unstubbed } from "@intentic/testing";
import { SETTLES, waitFor } from "@intentic/testing/bun";
import { createApp } from "../../app.js";
import type { CompositionCore } from "../../composition.js";
import { beginTurn } from "../../conversations/actor/conversation-actors.testing.js";
import { memoryFleet } from "../../conversations/registry/agents-registry.testing.js";
import { createBranchCheckouts } from "../../conversations/worktrees/branches/branch-checkouts.js";
import { noIsolation } from "../../conversations/worktrees/isolation.testing.js";
import { createAgentWorktrees } from "../../conversations/worktrees/worktrees.js";
import { clientFor, errorCode } from "../../harness/route-client.testing.js";
import { services } from "../../harness/route-services.testing.js";
import { createLogger } from "../../logger.js";
import { createPerfTracker } from "../../system/resources/perf.js";
import { workspacePaths } from "../../workspace/workspace.js";
import { createWorkspaceSlice } from "../../workspace/workspace-slice.js";
import { testConfig } from "../../env.config.testing.js";
import { gitSlice } from "../git-slice.js";

const git = (dir: string, ...args: string[]): string => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

const setup = async () => {
    const root = mkdtempSync(join(tmpdir(), "git-view-"));
    roots.push(root);
    const work = join(root, "work");
    const app = join(work, "app");
    mkdirSync(app, { recursive: true });
    for (const dir of [work, app]) {
        git(dir, "init", "-q", "-b", "main");
        git(dir, "config", "user.name", "test");
        git(dir, "config", "user.email", "test@example.com");
        writeFileSync(join(dir, "README.md"), "baseline\n");
        writeFileSync(join(dir, ".gitignore"), "app/\n.intentic/local/\n");
        git(dir, "add", "README.md", ".gitignore");
        git(dir, "commit", "-qm", "baseline");
    }
    git(app, "branch", "feature");
    const workspace = workspacePaths(work);
    const historyRoot = join(root, "history");
    const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });
    const worktrees = createAgentWorktrees({ workspace, historyRoot, worktreesRoot: join(historyRoot, "worktrees"), isolation: noIsolation(work, historyRoot), logger, perf: createPerfTracker(logger) });
    const branchCheckouts = createBranchCheckouts({ historyRoot, worktrees, logger });
    const fleet = memoryFleet();
    await beginTurn(fleet.conversations, { conversationId: "review-copy", isolated: true, prompt: "edit", profile: { agent: "claude", harness: "native" } }, 1_000);
    const copy = await worktrees.ensure("review-copy", []);
    await fleet.agents.recordWorktree("review-copy", copy.repos);
    await fleet.conversations.send("review-copy", { kind: "settle" }).settled;
    const config = { ...testConfig, workspaceRoot: work, historyRoot };
    const core = unstubbed<CompositionCore>("core", { config, workspace, logger });
    const daemon = services({ ...fleet, ...createWorkspaceSlice({ config, logger }), ...historySlice.build(core), config, workspace, workspaceScope: { main: work, entry: fleet.agents.entry, worktreeDir: (id) => worktrees.worktreeDir(id, "root"), branches: branchCheckouts }, agentWorktrees: worktrees, branchCheckouts, git: gitSlice.build(core).git });
    const server = createApp(daemon);
    return { work, app, worktrees, branchCheckouts, server, client: clientFor(server) };
};

test.each(["branch", "worktree"] as const)("%s changes, index, commits and discard stay in the selected checkout", async (kind) => {
    const { work, app, worktrees, branchCheckouts, server, client } = await setup();
    const view: GitView = kind === "branch" ? { repo: "app", branch: "feature" } : { agent: "review-copy" };
    const dir = kind === "branch" ? await branchCheckouts.ensure("app", "feature") : worktrees.worktreeDir("review-copy", "app");
    const mainHead = git(app, "rev-parse", "HEAD");
    writeFileSync(join(app, "README.md"), "shared edit\n");
    git(app, "add", "README.md");
    writeFileSync(join(dir, "README.md"), "selected edit\n");
    const row = (await client.git.viewChanges({ view })).repos.find(({ repo }) => repo === "app");
    expect(row?.unstaged.map(({ path }) => path)).toEqual(["README.md"]);
    expect(row?.staged).toEqual([]);
    await client.git.stage({ repo: "app", paths: ["README.md"], view });
    const diff = await client.git.fileDiff({ repo: "app", path: "README.md", side: "staged", view });
    expect(diff.before).toBe("baseline\n");
    expect(diff.after).toBe("selected edit\n");
    const rawQuery = new URLSearchParams({ source: "working", repo: "app", path: "README.md", side: "staged", which: "after", view: JSON.stringify(view) });
    expect(await (await server.request(`/diff/raw?${rawQuery}`)).text()).toBe("selected edit\n");
    writeFileSync(join(dir, "README.md"), "selected unstaged bytes\n");
    rawQuery.set("side", "unstaged");
    expect(await (await server.request(`/diff/raw?${rawQuery}`)).text()).toBe("selected unstaged bytes\n");
    writeFileSync(join(dir, "README.md"), "selected edit\n");
    await client.git.unstage({ repo: "app", paths: ["README.md"], view });
    expect(git(dir, "diff", "--cached", "--name-only")).toBe("");
    await client.git.indexRunStart({ repo: "app", op: "commit", message: "test: selected checkout", target: {}, view });
    const run = await waitFor(async () => {
        const state = await client.git.indexRunState({ repo: "app", view });
        expect(state.status).toBe("passed");
        return state;
    }, SETTLES);
    expect(run.result?.committed).toBe(true);
    expect(git(dir, "show", "HEAD:README.md")).toBe("selected edit");
    writeFileSync(join(dir, "README.md"), "discard this\n");
    await client.git.discard({ repo: "app", paths: ["README.md"], view });
    expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("selected edit\n");
    expect(git(app, "rev-parse", "HEAD")).toBe(mainHead);
    expect(git(app, "show", ":README.md")).toBe("shared edit");
    expect(readFileSync(join(work, "README.md"), "utf8")).toBe("baseline\n");
    expect((await client.git.indexRunState({ repo: "app" })).status).toBe("idle");
});

test("a branch view refuses a repository outside its checkout instead of using the shared index", async () => {
    const { work, client } = await setup();
    writeFileSync(join(work, "README.md"), "keep this\n");
    expect(await errorCode(client.git.stage({ repo: "root", view: { repo: "app", branch: "feature" } }))).toBe("NOT_FOUND");
    expect(git(work, "diff", "--cached", "--name-only")).toBe("");
});


test.each(["branch", "worktree"] as const)("%s editor saves and file operations stay in the selected checkout", async (kind) => {
    const { work, app, worktrees, branchCheckouts, server, client } = await setup();
    const view: GitView = kind === "branch" ? { repo: "app", branch: "feature" } : { agent: "review-copy" };
    const dir = kind === "branch" ? await branchCheckouts.ensure("app", "feature") : worktrees.worktreeDir("review-copy", "app");
    const query = new URLSearchParams({ path: "app/README.md" });
    if (kind === "branch") { query.set("repo", "app"); query.set("branch", "feature"); }
    else { query.set("agent", "review-copy"); }
    expect((await server.request(`/workspace/upload?${query}`, { method: "POST", body: "saved in selected copy\n" })).status).toBe(200);
    expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("saved in selected copy\n");
    await client.workspace.mkdir({ path: "app/folder", view });
    await client.workspace.copy({ from: "app/README.md", to: "app/folder/copy.md", view });
    await client.workspace.move({ from: "app/folder/copy.md", to: "app/folder/moved.md", view });
    const removed = await client.workspace.delete({ path: "app/folder/moved.md", view });
    expect(removed.trashed).toEqual(expect.any(String));
    expect(await client.workspace.restore({ trashed: removed.trashed!, view })).toEqual({ path: "app/folder/moved.md" });
    expect(readFileSync(join(dir, "folder/moved.md"), "utf8")).toBe("saved in selected copy\n");
    expect(readFileSync(join(app, "README.md"), "utf8")).toBe("baseline\n");
    expect(git(app, "status", "--porcelain")).toBe("");
    expect(git(work, "status", "--porcelain")).toBe("");
    if (kind === "branch") {
        expect((await server.request(`/workspace/upload?${new URLSearchParams({ path: "README.md", repo: "app", branch: "feature" })}`, { method: "POST", body: "wrong checkout" })).status).toBe(400);
    }
});

test("a malformed checkout selection cannot stage the shared index", async () => {
    const { work, server } = await setup();
    writeFileSync(join(work, "README.md"), "shared work\n");
    const response = await server.request("/git/root/stage", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ view: { repo: "app" } }),
    });
    expect(response.status).toBe(400);
    expect(git(work, "diff", "--cached", "--name-only")).toBe("");
});
