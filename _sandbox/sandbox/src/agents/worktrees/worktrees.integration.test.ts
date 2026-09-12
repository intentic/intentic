import { execFile } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { STATE_DIR } from "@intentic/constants";
import { gitInit } from "@intentic/scaffold";
import { afterEach, expect, test } from "vitest";
import { noIsolation } from "../../testing.js";
import { ensureRootRepo } from "../../git/remote/root-repo.js";
import { repoGitDir } from "../../history/history.js";
import { createLogger } from "../../logger.js";
import { createPerfTracker } from "../../platform/resources/perf.js";
import { workspacePaths } from "../../workspace/workspace.js";
import { createAgentWorktrees } from "./worktrees.js";

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });
const perf = createPerfTracker(logger);

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

// A production-shaped workspace: /work with a --separate-git-dir root repo and one nested intent role repo, real git
// dirs on the history volume that worktrees must operate over.
const setup = async (): Promise<{ work: string; historyRoot: string; worktrees: ReturnType<typeof createAgentWorktrees> }> => {
    const base = await mkdtemp(join(tmpdir(), "intentic-worktrees-"));
    tempDirs.push(base);
    const work = join(base, "work");
    const historyRoot = join(base, "history");
    const workspace = workspacePaths(work);
    // The nested repo exists before the root repo is ensured, so root's derived exclude list covers /intent/.
    await mkdir(work, { recursive: true });
    const intent = join(workspace.root, "intent");
    await gitInit(intent, repoGitDir(historyRoot, "intent"));
    await writeFile(join(intent, "deploy.config.ts"), "v1\n");
    await sh(intent, "add", "-A");
    await sh(intent, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "intent v1");
    // The root repo: --separate-git-dir on /history plus the derived exclude list.
    await ensureRootRepo(workspace, historyRoot);
    await writeFile(join(work, "CLAUDE.md"), "workspace notes\n");
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
    return { work, historyRoot, worktrees };
};

// One package's installed tree; untracked by design, which a worktree checkout cannot carry.
const deps = async (repo: string, pkg: string): Promise<void> => {
    await mkdir(join(repo, pkg, "node_modules", "dep"), { recursive: true });
    await writeFile(join(repo, pkg, "node_modules", "dep", "index.js"), `dep of ${pkg === "" ? "root" : pkg}\n`);
};

// A repo with dependencies installed like a real one: ignore rule, tracked package dirs, node_modules outside git.
// `rule` is the repo's own, whatever shape it takes; pkg/b stays uninstalled for a later re-ensure.
const install = async (repo: string, rule: string): Promise<void> => {
    await writeFile(join(repo, ".gitignore"), `${rule}\n`);
    for (const pkg of ["pkg/a", "pkg/b"]) {
        await mkdir(join(repo, pkg), { recursive: true });
        await writeFile(join(repo, pkg, "package.json"), "{}\n");
    }
    await sh(repo, "add", "-A");
    await sh(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "packages");
    await deps(repo, "");
    await deps(repo, "pkg/a");
};

test("a supplied snapshot creates every repository at the same captured commits after main moves", async () => {
    const { work, worktrees } = await setup();
    const snapshot = await worktrees.snapshot();

    await writeFile(join(work, "CLAUDE.md"), "new workspace notes\n");
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "root moved");
    const intent = join(work, "intent");
    await writeFile(join(intent, "deploy.config.ts"), "v2\n");
    await sh(intent, "add", "-A");
    await sh(intent, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "intent moved");

    const conversation = await worktrees.ensure("c1", [], snapshot);

    expect(conversation.repos).toEqual(snapshot);
    expect(await readFile(join(conversation.cwd, "CLAUDE.md"), "utf8")).toBe("workspace notes\n");
    expect(await readFile(join(conversation.cwd, "intent", "deploy.config.ts"), "utf8")).toBe("v1\n");
});

test("a worktree resolves dependencies through links to the main checkout", async () => {
    const { work, worktrees } = await setup();
    await install(join(work, "intent"), "**/node_modules");

    const conversation = await worktrees.ensure("c1", []);
    const worktree = join(conversation.cwd, "intent");

    expect(lstatSync(join(worktree, "node_modules")).isSymbolicLink()).toBe(true);
    expect(await readlink(join(worktree, "node_modules"))).toBe(join(work, "intent", "node_modules"));
    expect(await readFile(join(worktree, "node_modules", "dep", "index.js"), "utf8")).toBe("dep of root\n");
    expect(await readFile(join(worktree, "pkg", "a", "node_modules", "dep", "index.js"), "utf8")).toBe("dep of pkg/a\n");
    expect(existsSync(join(worktree, "pkg", "b", "node_modules"))).toBe(false);
});

test("a package's build output is mirrored alongside its dependencies", async () => {
    const { work, worktrees } = await setup();
    const intent = join(work, "intent");
    await install(intent, "**/node_modules\n**/dist");
    await mkdir(join(intent, "pkg", "a", "dist"), { recursive: true });
    await writeFile(join(intent, "pkg", "a", "dist", "index.js"), "built\n");

    const conversation = await worktrees.ensure("c1", []);
    const worktree = join(conversation.cwd, "intent");

    expect(await readFile(join(worktree, "pkg", "a", "dist", "index.js"), "utf8")).toBe("built\n");
    expect(await sh(worktree, "status", "--porcelain")).toBe("");
});

test("a tracked build output is left as the checkout's own", async () => {
    const { work, worktrees } = await setup();
    const intent = join(work, "intent");
    await install(intent, "**/node_modules");
    await mkdir(join(intent, "pkg", "a", "dist"), { recursive: true });
    await writeFile(join(intent, "pkg", "a", "dist", "index.js"), "committed\n");
    await sh(intent, "add", "-A");
    await sh(intent, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "dist");

    const conversation = await worktrees.ensure("c1", []);
    const worktree = join(conversation.cwd, "intent");

    expect(lstatSync(join(worktree, "pkg", "a", "dist")).isSymbolicLink()).toBe(false);
    expect(await readFile(join(worktree, "pkg", "a", "dist", "index.js"), "utf8")).toBe("committed\n");
});

test("the mirror stays out of git, so retire cannot commit it onto the branch", async () => {
    const { work, worktrees } = await setup();
    await install(join(work, "intent"), "**/node_modules");
    const conversation = await worktrees.ensure("c1", []);
    expect(await sh(join(conversation.cwd, "intent"), "status", "--porcelain")).toBe("");

    // Real work beside the links, so retire has something to commit.
    await writeFile(join(conversation.cwd, "intent", "deploy.config.ts"), "agent edit\n");
    await worktrees.retire("c1", conversation.repos, "t");

    expect(await sh(join(work, "intent"), "show", "agent/c1:deploy.config.ts")).toBe("agent edit");
    expect(await sh(join(work, "intent"), "ls-tree", "-r", "--name-only", "agent/c1")).not.toContain("node_modules");
});

// `node_modules/` matches directories only, never the symlink a mirror is: the repo's own rule cannot keep one out of
// `git add -A`, and a mirror committed onto the branch blocks every land afterwards with a conflict neither side can
// clear. The exclude file git keeps beside the repo covers the symlink form, so the mirror is safe here too.
test("a repo whose ignore rule is directory-only is mirrored, and the mirror still stays out of git", async () => {
    const { work, worktrees } = await setup();
    await install(join(work, "intent"), "node_modules/");

    const conversation = await worktrees.ensure("c1", []);
    const worktree = join(conversation.cwd, "intent");

    expect(lstatSync(join(worktree, "node_modules")).isSymbolicLink()).toBe(true);
    expect(await readFile(join(worktree, "pkg", "a", "node_modules", "dep", "index.js"), "utf8")).toBe("dep of pkg/a\n");
    expect(await sh(worktree, "status", "--porcelain")).toBe("");

    await writeFile(join(worktree, "deploy.config.ts"), "agent edit\n");
    await worktrees.retire("c1", conversation.repos, "t");

    expect(await sh(join(work, "intent"), "ls-tree", "-r", "--name-only", "agent/c1")).not.toContain("node_modules");
});

// The sequence that stranded a real agent: a namespaced turn leaves an empty mount point where the mirror goes, and
// `node_modules/` DOES match that directory. Reading the ignore answer off it said "safe to link", the link replaced it
// with a symlink the same rule does not match, and the pre-turn `add -A` committed a machine-local path onto the
// branch — which no land can ever apply over the user's own node_modules, by an agent or by hand.
test("a mount point left by a namespaced turn does not make the symlink that replaces it stageable", async () => {
    const { work, historyRoot, worktrees } = await setup();
    await install(join(work, "intent"), "node_modules/");
    const namespaced = createAgentWorktrees({
        workspace: workspacePaths(work),
        worktreesRoot: join(historyRoot, "worktrees"),
        historyRoot,
        isolation: { ...noIsolation(work, historyRoot), available: async () => true },
        logger,
        perf,
    });
    const created = await namespaced.ensure("c1", []);
    const worktree = join(created.cwd, "intent");
    expect(lstatSync(join(worktree, "node_modules")).isDirectory()).toBe(true);

    // The next turn is cwd-only (Codex, ACP, Pi, Cursor): the mount point becomes a symlink.
    await worktrees.ensure("c1", created.repos);

    expect(lstatSync(join(worktree, "node_modules")).isSymbolicLink()).toBe(true);
    expect(await sh(worktree, "status", "--porcelain")).toBe("");

    await writeFile(join(worktree, "deploy.config.ts"), "agent edit\n");
    await worktrees.retire("c1", created.repos, "t");

    expect(await sh(join(work, "intent"), "ls-tree", "-r", "--name-only", "agent/c1")).not.toContain("node_modules");
});

// The repo itself un-ignores the path, and a tracked .gitignore outranks the exclude file, so no link may stand.
test("a repo that un-ignores a mirror path is left unmirrored", async () => {
    const { work, worktrees } = await setup();
    await install(join(work, "intent"), "node_modules/\n!node_modules");

    const conversation = await worktrees.ensure("c1", []);

    expect(existsSync(join(conversation.cwd, "intent", "node_modules"))).toBe(false);
    expect(await sh(join(conversation.cwd, "intent"), "status", "--porcelain")).toBe("");
});

test("re-ensure keeps existing links and mirrors packages installed since the checkout", async () => {
    const { work, worktrees } = await setup();
    const intent = join(work, "intent");
    await install(intent, "**/node_modules");
    const created = await worktrees.ensure("c1", []);

    await deps(intent, "pkg/b");
    const restored = await worktrees.ensure("c1", created.repos);
    const worktree = join(restored.cwd, "intent");

    expect(await readFile(join(worktree, "pkg", "b", "node_modules", "dep", "index.js"), "utf8")).toBe("dep of pkg/b\n");
    expect(await readlink(join(worktree, "node_modules"))).toBe(join(intent, "node_modules"));
    expect(await sh(worktree, "status", "--porcelain")).toBe("");
});

// The mirror's form belongs to the container, not the worktree, which outlives it on /history; ensure converges the
// mirror to the container's current mode.
test("re-ensure converts pre-namespace symlinks into mount points once isolation is available", async () => {
    const { work, historyRoot, worktrees } = await setup();
    const intent = join(work, "intent");
    await install(intent, "**/node_modules");
    const created = await worktrees.ensure("c1", []);
    const worktree = join(created.cwd, "intent");
    expect(lstatSync(join(worktree, "node_modules")).isSymbolicLink()).toBe(true);

    // The container now has CAP_SYS_ADMIN: same worktree, a different isolation mode.
    const isolated = createAgentWorktrees({
        workspace: workspacePaths(work),
        worktreesRoot: join(historyRoot, "worktrees"),
        historyRoot,
        isolation: { ...noIsolation(work, historyRoot), available: async () => true },
        logger,
        perf,
    });
    await isolated.ensure("c1", created.repos);

    const entry = lstatSync(join(worktree, "node_modules"));
    expect(entry.isSymbolicLink()).toBe(false);
    expect(entry.isDirectory()).toBe(true);
    // Empty: the namespace binds the real tree onto it.
    expect(await readdir(join(worktree, "node_modules"))).toEqual([]);
    expect(lstatSync(join(worktree, "pkg", "a", "node_modules")).isDirectory()).toBe(true);
});

// The mirror's form also depends on the turn: only the Claude Code loop enters the namespace, so a Codex, ACP or Pi
// turn, cwd'd into the worktree directly, needs the symlink even when the container could build one.
test("a turn that enters no namespace gets the symlink even where the container could build one", async () => {
    const { work, historyRoot } = await setup();
    const intent = join(work, "intent");
    await install(intent, "**/node_modules");
    const capable = createAgentWorktrees({
        workspace: workspacePaths(work),
        worktreesRoot: join(historyRoot, "worktrees"),
        historyRoot,
        isolation: { ...noIsolation(work, historyRoot), available: async () => true },
        logger,
        perf,
    });

    // The turn about to run enters no namespace, so the mirror must resolve on its own.
    const created = await capable.ensure("c1", [], undefined, false);
    const worktree = join(created.cwd, "intent");
    expect(lstatSync(join(worktree, "node_modules")).isSymbolicLink()).toBe(true);
    expect(await readFile(join(worktree, "node_modules", "dep", "index.js"), "utf8")).toBe("dep of root\n");

    // The next turn is on the Claude Code loop, entering a namespace: back to a mount point.
    await capable.ensure("c1", created.repos, undefined, true);
    const entry = lstatSync(join(worktree, "node_modules"));
    expect(entry.isSymbolicLink()).toBe(false);
    expect(await readdir(join(worktree, "node_modules"))).toEqual([]);
});

test("re-ensure restores the symlink when isolation is lost, but never over a real install", async () => {
    const { work, historyRoot, worktrees } = await setup();
    const intent = join(work, "intent");
    await install(intent, "**/node_modules");
    const isolated = createAgentWorktrees({
        workspace: workspacePaths(work),
        worktreesRoot: join(historyRoot, "worktrees"),
        historyRoot,
        isolation: { ...noIsolation(work, historyRoot), available: async () => true },
        logger,
        perf,
    });
    const created = await isolated.ensure("c1", []);
    const worktree = join(created.cwd, "intent");
    // Real content inside the worktree; the flip back to a symlink must not delete it.
    await writeFile(join(worktree, "pkg", "a", "node_modules", "local.js"), "installed\n");

    await worktrees.ensure("c1", created.repos);

    expect(lstatSync(join(worktree, "node_modules")).isSymbolicLink()).toBe(true);
    expect(await readlink(join(worktree, "node_modules"))).toBe(join(intent, "node_modules"));
    expect(lstatSync(join(worktree, "pkg", "a", "node_modules")).isDirectory()).toBe(true);
    expect(await readFile(join(worktree, "pkg", "a", "node_modules", "local.js"), "utf8")).toBe("installed\n");
});

// A package the checkout never had is not mirrored: there is no directory in the worktree to attach a link to.
test("a package absent from the agent's branch is not mirrored into its worktree", async () => {
    const { work, worktrees } = await setup();
    const intent = join(work, "intent");
    await install(intent, "**/node_modules");
    const created = await worktrees.ensure("c1", []);

    await mkdir(join(intent, "pkg", "later"), { recursive: true });
    await writeFile(join(intent, "pkg", "later", "package.json"), "{}\n");
    await deps(intent, "pkg/later");

    const restored = await worktrees.ensure("c1", created.repos);
    expect(existsSync(join(restored.cwd, "intent", "pkg", "later"))).toBe(false);
});

// Links point at the owner's real dependency trees; teardown must not follow them and delete the installed packages.
test("teardown drops the links without touching the main checkout's dependencies", async () => {
    const { work, worktrees } = await setup();
    const intent = join(work, "intent");
    await install(intent, "**/node_modules");
    const conversation = await worktrees.ensure("c1", []);
    expect(existsSync(join(conversation.cwd, "intent", "node_modules"))).toBe(true);

    await worktrees.remove("c1", conversation.repos);

    expect(existsSync(conversation.cwd)).toBe(false);
    expect(await readFile(join(intent, "node_modules", "dep", "index.js"), "utf8")).toBe("dep of root\n");
    expect(await readFile(join(intent, "pkg", "a", "node_modules", "dep", "index.js"), "utf8")).toBe("dep of pkg/a\n");
});

test("ensure creates the mirrored composition with agent branches and recorded bases", async () => {
    const { work, worktrees } = await setup();
    const conversation = await worktrees.ensure("c1", []);

    expect(conversation.branch).toBe("agent/c1");
    expect(conversation.repos.map((repo) => repo.repo).toSorted()).toEqual(["intent", "root"]);
    // The checkout mirrors /work: the root worktree holds the workspace files; the nested repo mounts inside.
    expect(await readFile(join(conversation.cwd, "CLAUDE.md"), "utf8")).toBe("workspace notes\n");
    expect(await readFile(join(conversation.cwd, "intent", "deploy.config.ts"), "utf8")).toBe("v1\n");
    expect(await sh(conversation.cwd, "branch", "--show-current")).toBe("agent/c1");
    // Bases are the mains' HEAD shas at creation.
    const rootBase = conversation.repos.find((repo) => repo.repo === "root")?.base;
    expect(rootBase).toBe(await sh(work, "rev-parse", "HEAD"));
});

test("worktree edits stay isolated from the main tree", async () => {
    const { work, worktrees } = await setup();
    const conversation = await worktrees.ensure("c1", []);
    await writeFile(join(conversation.cwd, "intent", "deploy.config.ts"), "agent edit\n");
    await writeFile(join(conversation.cwd, "new-file.md"), "agent file\n");

    expect(await sh(work, "status", "--porcelain")).toBe("");
    expect(await sh(join(work, "intent"), "status", "--porcelain")).toBe("");
    expect(existsSync(join(work, "new-file.md"))).toBe(false);
    expect(await readFile(join(work, "intent", "deploy.config.ts"), "utf8")).toBe("v1\n");
});

test("ensure with a recorded composition repairs a deleted .git pointer", async () => {
    const { worktrees } = await setup();
    const created = await worktrees.ensure("c1", []);
    await rm(join(created.cwd, ".git"));

    const repaired = await worktrees.ensure("c1", created.repos);
    expect(repaired.repos).toEqual(created.repos);
    expect(await sh(repaired.cwd, "branch", "--show-current")).toBe("agent/c1");
});

test("remove tears down worktrees and branches; prune sweeps orphan dirs", async () => {
    const { work, historyRoot, worktrees } = await setup();
    const conversation = await worktrees.ensure("c1", []);
    await worktrees.remove("c1", conversation.repos);

    expect(existsSync(conversation.cwd)).toBe(false);
    await expect(sh(work, "rev-parse", "-q", "--verify", "refs/heads/agent/c1")).rejects.toThrow();

    const orphan = join(historyRoot, "worktrees", "ghost");
    await mkdir(orphan, { recursive: true });
    await worktrees.prune(
        () => ["kept"],
        () => [],
    );
    expect(existsSync(orphan)).toBe(false);
});

// Retiring a checkout must cost nothing but the checkout: the branch must capture uncommitted state before the checkout
// is dropped.
test("retire commits the worktree's uncommitted state onto the branch and keeps it", async () => {
    const { work, worktrees } = await setup();
    const conversation = await worktrees.ensure("c1", []);
    await writeFile(join(conversation.cwd, "new-file.md"), "agent file\n");
    await writeFile(join(conversation.cwd, "intent", "deploy.config.ts"), "agent edit\n");

    await worktrees.retire("c1", conversation.repos, "Fix the parser");

    expect(existsSync(conversation.cwd)).toBe(false);
    expect(await sh(work, "rev-parse", "-q", "--verify", "agent/c1")).not.toBe("");
    expect(await sh(work, "show", "agent/c1:new-file.md")).toBe("agent file");
    expect(await sh(join(work, "intent"), "show", "agent/c1:deploy.config.ts")).toBe("agent edit");
    expect(await sh(work, "log", "-1", "--format=%s", "agent/c1")).toBe("Agent: Fix the parser");
    expect(await sh(work, "status", "--porcelain")).toBe("");
});

test("a retired agent's checkout comes back from its branch, with its work", async () => {
    const { worktrees } = await setup();
    const created = await worktrees.ensure("c1", []);
    await writeFile(join(created.cwd, "new-file.md"), "agent file\n");
    await worktrees.retire("c1", created.repos, undefined);

    const restored = await worktrees.ensure("c1", created.repos);
    expect(restored.repos).toEqual(created.repos);
    expect(await sh(restored.cwd, "branch", "--show-current")).toBe("agent/c1");
    expect(await readFile(join(restored.cwd, "new-file.md"), "utf8")).toBe("agent file\n");
    expect(await readFile(join(restored.cwd, "intent", "deploy.config.ts"), "utf8")).toBe("v1\n");
});

// Deleting a nested repo takes `<repo>/.git/worktrees/<name>` with it, leaving a dangling checkout where every git
// command fails; retire reclaims what it can there while preserving the repos that still exist.
test("retire reclaims a checkout whose repository was deleted from the workspace, and still preserves the rest", async () => {
    const { work, worktrees } = await setup();
    // A user-cloned repo keeps its git dir inside it, not on /history, so deleting it deletes the admin area too.
    const vendor = join(work, "vendor");
    await mkdir(vendor, { recursive: true });
    await sh(work, "init", "-q", vendor);
    await writeFile(join(vendor, "lib.ts"), "v1\n");
    await sh(vendor, "add", "-A");
    await sh(vendor, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "vendor v1");
    const conversation = await worktrees.ensure("c1", []);
    expect(conversation.repos.map(({ repo }) => repo)).toContain("vendor");
    await writeFile(join(conversation.cwd, "new-file.md"), "agent file\n");
    await writeFile(join(conversation.cwd, "vendor", "lib.ts"), "agent edit\n");
    await rm(vendor, { recursive: true, force: true });

    await worktrees.retire("c1", conversation.repos, "Fix the parser");

    expect(existsSync(conversation.cwd)).toBe(false);
    expect(await sh(work, "show", "agent/c1:new-file.md")).toBe("agent file");
});

test("retire is a no-op on a clean worktree beyond dropping the checkout", async () => {
    const { work, worktrees } = await setup();
    const conversation = await worktrees.ensure("c1", []);
    const tip = await sh(work, "rev-parse", "agent/c1");

    await worktrees.retire("c1", conversation.repos, "nothing to do");

    expect(existsSync(conversation.cwd)).toBe(false);
    expect(await sh(work, "rev-parse", "agent/c1")).toBe(tip);
});

test("retire takes the branch off refs/heads and ensure puts it back", async () => {
    const { work, worktrees } = await setup();
    const created = await worktrees.ensure("c1", []);
    await writeFile(join(created.cwd, "new-file.md"), "agent file\n");
    const tip = await sh(work, "rev-parse", "agent/c1");

    await worktrees.retire("c1", created.repos, undefined);

    expect(await sh(work, "for-each-ref", "--format=%(refname)", "refs/heads/agent/")).toBe("");
    expect(await sh(join(work, "intent"), "for-each-ref", "--format=%(refname)", "refs/heads/agent/")).toBe("");
    // The branch name in entry.branch is unchanged when parked; only its ref namespace moves.
    expect(await sh(work, "rev-parse", "refs/agent/c1")).toBe(await sh(work, "rev-parse", "agent/c1"));
    expect(await sh(work, "merge-base", "--is-ancestor", tip, "agent/c1")).toBe("");
    expect(await sh(work, "show", "agent/c1:new-file.md")).toBe("agent file");

    // Resuming needs a real branch, not a detached checkout, or the turn's commits would be lost.
    const restored = await worktrees.ensure("c1", created.repos);
    expect(await sh(restored.cwd, "branch", "--show-current")).toBe("agent/c1");
    expect(await sh(work, "for-each-ref", "--format=%(refname)", "refs/agent/")).toBe("");
    expect(await readFile(join(restored.cwd, "new-file.md"), "utf8")).toBe("agent file\n");
});

test("prune parks the branches of agents that are off the board and drops refs no entry claims", async () => {
    const { work, worktrees } = await setup();
    const archived = await worktrees.ensure("c1", []);
    await worktrees.ensure("c2", []);
    // Simulates an archived branch left on refs/heads instead of parked to refs/agent/.
    await worktrees.retire("c1", archived.repos, undefined);
    await sh(work, "branch", "agent/c1", "refs/agent/c1");
    await sh(work, "update-ref", "-d", "refs/agent/c1");
    // A parked ref whose conversation the registry no longer lists.
    await sh(work, "update-ref", "refs/agent/ghost", await sh(work, "rev-parse", "HEAD"));

    await worktrees.prune(
        () => ["c1", "c2"],
        () => ["c1"],
    );

    // The sweep never touches a repo that is still checked out.
    expect(await sh(work, "for-each-ref", "--format=%(refname:short)", "refs/heads/agent/")).toBe("agent/c2");
    expect(await sh(work, "rev-parse", "-q", "--verify", "refs/agent/c1")).not.toBe("");
    await expect(sh(work, "rev-parse", "-q", "--verify", "refs/agent/ghost")).rejects.toThrow();
});

test("remove drops a parked agent's commits, not just its branch", async () => {
    const { work, worktrees } = await setup();
    const created = await worktrees.ensure("c1", []);
    await worktrees.retire("c1", created.repos, undefined);

    // Discarding an archived agent: `branch -D` alone finds nothing and leaves the parked ref behind.
    await worktrees.remove("c1", created.repos);

    await expect(sh(work, "rev-parse", "-q", "--verify", "agent/c1")).rejects.toThrow();
    expect(await sh(join(work, "intent"), "for-each-ref", "--format=%(refname)", "refs/agent/")).toBe("");
});

test("an unborn-HEAD repo is excluded from the composition", async () => {
    const { work, historyRoot, worktrees } = await setup();
    const empty = join(work, "empty-repo");
    await gitInit(empty, repoGitDir(historyRoot, "empty-repo"));

    const conversation = await worktrees.ensure("c1", []);
    expect(conversation.repos.map((repo) => repo.repo)).not.toContain("empty-repo");
    expect(existsSync(join(conversation.cwd, "empty-repo"))).toBe(false);
});

// `.intentic/config` is tracked by the root repo and checked out here like any file. The untracked state-dir groups
// bind-mount in from the main tree instead (isolation.ts SHARED_STATE_PATHS), so no tracked path sits behind a bind.
test("the versioned state slice is checked out in the worktree and follows a rebase like any tracked file", async () => {
    const { work, worktrees } = await setup();
    await mkdir(join(work, STATE_DIR, "config"), { recursive: true });
    await writeFile(join(work, STATE_DIR, "config", "settings.json"), '{"model":"v1"}\n');
    // No --force: the root repo's derived exclude (ensureRootRepo) already carves this path back into `add -A`.
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "config v1");

    const conversation = await worktrees.ensure("c1", []);
    const checkedOut = join(conversation.cwd, STATE_DIR, "config", "settings.json");
    expect(await readFile(checkedOut, "utf8")).toBe('{"model":"v1"}\n');
    // `H`: an ordinary tracked entry, not skip-worktree.
    expect(await sh(conversation.cwd, "ls-files", "-v", `${STATE_DIR}/config/settings.json`)).toBe(`H ${STATE_DIR}/config/settings.json`);
    expect(await sh(conversation.cwd, "status", "--short")).toBe("");

    await writeFile(join(work, STATE_DIR, "config", "settings.json"), '{"model":"v2"}\n');
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "config v2");
    await sh(conversation.cwd, "-c", "user.name=t", "-c", "user.email=t@t", "rebase", "main");
    expect(await readFile(checkedOut, "utf8")).toBe('{"model":"v2"}\n');
    expect(await readFile(join(work, STATE_DIR, "config", "settings.json"), "utf8")).toBe('{"model":"v2"}\n');
    expect(await sh(work, "status", "--short")).toBe("");
});

// A selection is the repositories a conversation carries when its persona card names them; root is always included, a
// nested repo only when named.
test("a selection creates worktrees for root and the named repositories only", async () => {
    const { worktrees } = await setup();
    const conversation = await worktrees.ensure("c1", [], undefined, undefined, []);

    expect(conversation.repos.map(({ repo }) => repo)).toEqual(["root"]);
    expect(await readFile(join(conversation.cwd, "CLAUDE.md"), "utf8")).toBe("workspace notes\n");
    expect(existsSync(join(conversation.cwd, "intent"))).toBe(false);
    // A name that matches no live repository is ignored.
    const named = await worktrees.ensure("c2", [], undefined, undefined, ["intent", "not-cloned-yet"]);
    expect(named.repos.map(({ repo }) => repo)).toEqual(["root", "intent"]);
});

test("a repo the selection names joins a recorded composition at main's head, and the record says so", async () => {
    const { work, worktrees } = await setup();
    const created = await worktrees.ensure("c1", [], undefined, undefined, []);
    const intent = join(work, "intent");
    await writeFile(join(intent, "deploy.config.ts"), "v2\n");
    await sh(intent, "add", "-A");
    await sh(intent, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "intent moved");

    const widened = await worktrees.ensure("c1", created.repos, undefined, undefined, ["intent"]);

    expect(widened.repos.map(({ repo }) => repo)).toEqual(["root", "intent"]);
    expect(widened.repos.find(({ repo }) => repo === "intent")?.base).toBe(await sh(intent, "rev-parse", "HEAD"));
    expect(await readFile(join(widened.cwd, "intent", "deploy.config.ts"), "utf8")).toBe("v2\n");
    expect(await sh(join(widened.cwd, "intent"), "branch", "--show-current")).toBe("agent/c1");
    // A selection that already matches the record is a no-op returning the record itself.
    expect(await worktrees.ensure("c1", widened.repos, undefined, undefined, ["intent"])).toMatchObject({ repos: widened.repos });
});

test("a repo the selection drops leaves with its work committed onto the branch, and comes back with it", async () => {
    const { work, worktrees } = await setup();
    const created = await worktrees.ensure("c1", []);
    await writeFile(join(created.cwd, "intent", "deploy.config.ts"), "edited by the agent\n");

    const narrowed = await worktrees.ensure("c1", created.repos, undefined, undefined, []);

    expect(narrowed.repos.map(({ repo }) => repo)).toEqual(["root"]);
    expect(existsSync(join(narrowed.cwd, "intent"))).toBe(false);
    // The dropped repo's branch is parked off refs/heads, like a retired agent's.
    const intent = join(work, "intent");
    expect(await sh(intent, "show", "agent/c1:deploy.config.ts")).toBe("edited by the agent");
    expect(await sh(intent, "for-each-ref", "--format=%(refname)", "refs/heads/agent/")).toBe("");
    expect(await readFile(join(intent, "deploy.config.ts"), "utf8")).toBe("v1\n");

    const rejoined = await worktrees.ensure("c1", narrowed.repos, undefined, undefined, ["intent"]);
    expect(rejoined.repos.map(({ repo }) => repo)).toEqual(["root", "intent"]);
    expect(await readFile(join(rejoined.cwd, "intent", "deploy.config.ts"), "utf8")).toBe("edited by the agent\n");
    expect(await sh(join(rejoined.cwd, "intent"), "branch", "--show-current")).toBe("agent/c1");
});

test("a conversation with no selection keeps the composition it was born with", async () => {
    const { work, worktrees } = await setup();
    const created = await worktrees.ensure("c1", []);
    // A repo cloned after the conversation started does not join it when no selection was ever made.
    const later = join(work, "later");
    await gitInit(later, repoGitDir(join(work, "..", "history"), "later"));
    await writeFile(join(later, "a.txt"), "a\n");
    await sh(later, "add", "-A");
    await sh(later, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "later");

    const again = await worktrees.ensure("c1", created.repos);
    expect(again.repos).toEqual(created.repos);
    expect(existsSync(join(again.cwd, "later"))).toBe(false);
});
