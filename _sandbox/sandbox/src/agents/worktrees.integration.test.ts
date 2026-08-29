import { execFile } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gitInit } from "@intentic/scaffold";
import { afterEach, expect, test } from "vitest";
import { noIsolation } from "../testing.js";
import { ensureRootRepo } from "../git/root-repo.js";
import { repoGitDir } from "../history/history.js";
import { createLogger } from "../logger.js";
import { createPerfTracker } from "../platform/perf.js";
import { workspacePaths } from "../workspace/workspace.js";
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

// A production-shaped workspace: /work with a --separate-git-dir root repo (a committed baseline) and one
// nested "intent" role repo, real git dirs on the history volume: the layout worktrees must operate over.
const setup = async (): Promise<{ work: string; historyRoot: string; worktrees: ReturnType<typeof createAgentWorktrees> }> => {
    const base = await mkdtemp(join(tmpdir(), "intentic-worktrees-"));
    tempDirs.push(base);
    const work = join(base, "work");
    const historyRoot = join(base, "history");
    const workspace = workspacePaths(work);
    // The nested repo exists BEFORE the root repo is ensured (production boot order), so the root's derived
    // exclude list covers /intent/ and the baseline can't capture it.
    await mkdir(work, { recursive: true });
    const intent = join(workspace.root, "intent");
    await gitInit(intent, repoGitDir(historyRoot, "intent"));
    await writeFile(join(intent, "deploy.config.ts"), "v1\n");
    await sh(intent, "add", "-A");
    await sh(intent, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "intent v1");
    // The production root repo: --separate-git-dir on /history plus the derived exclude list.
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

// One package's installed tree. Untracked by design: this is exactly what a worktree checkout cannot carry.
const deps = async (repo: string, pkg: string): Promise<void> => {
    await mkdir(join(repo, pkg, "node_modules", "dep"), { recursive: true });
    await writeFile(join(repo, pkg, "node_modules", "dep", "index.js"), `dep of ${pkg === "" ? "root" : pkg}\n`);
};

// A repo with dependencies installed the way a real one has them: a committed ignore rule, tracked package
// dirs, and node_modules trees outside version control. `rule` is what decides whether mirroring is safe:
// only a rule matching FILES too can hide a symlink from `add -A`. pkg/b is tracked but left uninstalled, so a
// test can install it later and watch a re-ensure pick it up.
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

// The property isolated turns rest on: a checkout of TRACKED files alone cannot resolve a single import, so
// nothing type-checks, lints or tests in a worktree unless the installed trees are mirrored into it.
test("a worktree resolves dependencies through links to the main checkout", async () => {
    const { work, worktrees } = await setup();
    await install(join(work, "intent"), "**/node_modules");

    const conversation = await worktrees.ensure("c1", []);
    const worktree = join(conversation.cwd, "intent");

    // A link, not a copy, and one per installed package, at the same relative path.
    expect(lstatSync(join(worktree, "node_modules")).isSymbolicLink()).toBe(true);
    expect(await readlink(join(worktree, "node_modules"))).toBe(join(work, "intent", "node_modules"));
    expect(await readFile(join(worktree, "node_modules", "dep", "index.js"), "utf8")).toBe("dep of root\n");
    expect(await readFile(join(worktree, "pkg", "a", "node_modules", "dep", "index.js"), "utf8")).toBe("dep of pkg/a\n");
    // A tracked package with nothing installed has nothing to mirror.
    expect(existsSync(join(worktree, "pkg", "b", "node_modules"))).toBe(false);
});

// The half that was missing: node_modules alone lets a worktree resolve a THIRD-PARTY import and still not
// its own siblings', because a workspace package's entry point is its build output. Every suite that crosses a
// package boundary died at collection with "Failed to resolve entry for package".
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

// A repo that COMMITS its build output carries it in the checkout, and the mirror must keep its hands off:
// pointing that path at the main tree would hide the very files the agent's branch exists to change.
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

    // Real work alongside the links, so retire takes a commit rather than no-opping past the question.
    await writeFile(join(conversation.cwd, "intent", "deploy.config.ts"), "agent edit\n");
    await worktrees.retire("c1", conversation.repos, "t");

    expect(await sh(join(work, "intent"), "show", "agent/c1:deploy.config.ts")).toBe("agent edit");
    expect(await sh(join(work, "intent"), "ls-tree", "-r", "--name-only", "agent/c1")).not.toContain("node_modules");
});

// `node_modules/` matches DIRECTORIES only, and a symlink is not a directory: git would stage it and retire
// would put a machine-local absolute path on the branch, then into whatever land merges. Unmirrored (no
// tooling) is the correct trade against that.
test("a repo whose ignore rule is directory-only is left unmirrored", async () => {
    const { work, worktrees } = await setup();
    await install(join(work, "intent"), "node_modules/");

    const conversation = await worktrees.ensure("c1", []);

    expect(existsSync(join(conversation.cwd, "intent", "node_modules"))).toBe(false);
    expect(existsSync(join(conversation.cwd, "intent", "pkg", "a", "node_modules"))).toBe(false);
    expect(await sh(join(conversation.cwd, "intent"), "status", "--porcelain")).toBe("");
});

test("re-ensure keeps existing links and mirrors packages installed since the checkout", async () => {
    const { work, worktrees } = await setup();
    const intent = join(work, "intent");
    await install(intent, "**/node_modules");
    const created = await worktrees.ensure("c1", []);

    // An install that lands after the agent's checkout already exists: the next turn's ensure must see it.
    await deps(intent, "pkg/b");
    const restored = await worktrees.ensure("c1", created.repos);
    const worktree = join(restored.cwd, "intent");

    expect(await readFile(join(worktree, "pkg", "b", "node_modules", "dep", "index.js"), "utf8")).toBe("dep of pkg/b\n");
    // The links that were already there are untouched, not rebuilt into something else.
    expect(await readlink(join(worktree, "node_modules"))).toBe(join(intent, "node_modules"));
    expect(await sh(worktree, "status", "--porcelain")).toBe("");
});

// The mirror's form is a property of the CONTAINER, and worktrees outlive containers on /history: a checkout
// created without the namespace carries absolute symlinks that, inside one, resolve back into the worktree
// occupying /work: the anchor's mkdir dies on the loop. Ensure must converge the mirror to the current mode.
test("re-ensure converts pre-namespace symlinks into mount points once isolation is available", async () => {
    const { work, historyRoot, worktrees } = await setup();
    const intent = join(work, "intent");
    await install(intent, "**/node_modules");
    const created = await worktrees.ensure("c1", []);
    const worktree = join(created.cwd, "intent");
    expect(lstatSync(join(worktree, "node_modules")).isSymbolicLink()).toBe(true);

    // The container came back with CAP_SYS_ADMIN: same worktree, other mode.
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
    // A real tree the agent put inside its worktree: content the flip must never delete.
    await writeFile(join(worktree, "pkg", "a", "node_modules", "local.js"), "installed\n");

    await worktrees.ensure("c1", created.repos);

    expect(lstatSync(join(worktree, "node_modules")).isSymbolicLink()).toBe(true);
    expect(await readlink(join(worktree, "node_modules"))).toBe(join(intent, "node_modules"));
    expect(lstatSync(join(worktree, "pkg", "a", "node_modules")).isDirectory()).toBe(true);
    expect(await readFile(join(worktree, "pkg", "a", "node_modules", "local.js"), "utf8")).toBe("installed\n");
});

// A package dir the agent's branch never had is not a package to mirror: planting a link would mean first
// creating an untracked directory the checkout deliberately doesn't contain.
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

// The links point at the OWNER's real dependency trees. A teardown that followed them would delete the
// workspace's installed packages: the worst failure this mechanism could have.
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
    // The checkout mirrors /work: the root worktree holds the workspace files, the nested repo mounts inside.
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

// The property archiving rests on: retiring a checkout must cost NOTHING but the checkout. If the branch did
// not capture the worktree's uncommitted state first, an automatic sweep would be a data-loss bug on a timer.
test("retire commits the worktree's uncommitted state onto the branch and keeps it", async () => {
    const { work, worktrees } = await setup();
    const conversation = await worktrees.ensure("c1", []);
    await writeFile(join(conversation.cwd, "new-file.md"), "agent file\n");
    await writeFile(join(conversation.cwd, "intent", "deploy.config.ts"), "agent edit\n");

    await worktrees.retire("c1", conversation.repos, "Fix the parser");

    // The checkout is gone: that is the whole point, one file tree per repo reclaimed.
    expect(existsSync(conversation.cwd)).toBe(false);
    // Both repos' commits survive, and both hold the work the worktree was holding loose: read by the same
    // `agent/c1` name the live conversation used, which is the property parking is built to preserve.
    expect(await sh(work, "rev-parse", "-q", "--verify", "agent/c1")).not.toBe("");
    expect(await sh(work, "show", "agent/c1:new-file.md")).toBe("agent file");
    expect(await sh(join(work, "intent"), "show", "agent/c1:deploy.config.ts")).toBe("agent edit");
    expect(await sh(work, "log", "-1", "--format=%s", "agent/c1")).toBe("Agent: Fix the parser");
    // And the main tree is untouched by any of it.
    expect(await sh(work, "status", "--porcelain")).toBe("");
});

test("a retired agent's checkout comes back from its branch, with its work", async () => {
    const { worktrees } = await setup();
    const created = await worktrees.ensure("c1", []);
    await writeFile(join(created.cwd, "new-file.md"), "agent file\n");
    await worktrees.retire("c1", created.repos, undefined);

    // What the next turn does: ensure() against the recorded composition re-attaches from the surviving branch.
    const restored = await worktrees.ensure("c1", created.repos);
    expect(restored.repos).toEqual(created.repos);
    expect(await sh(restored.cwd, "branch", "--show-current")).toBe("agent/c1");
    expect(await readFile(join(restored.cwd, "new-file.md"), "utf8")).toBe("agent file\n");
    expect(await readFile(join(restored.cwd, "intent", "deploy.config.ts"), "utf8")).toBe("v1\n");
});

/* THE CHECKOUT WHOSE REPOSITORY WENT AWAY, and the report this exists for: a nested repo deleted from the
 * workspace takes `<repo>/.git/worktrees/<name>` with it, so the conversation's checkout of it is a dangling
 * pointer and EVERY git command in it dies with "fatal: not a git repository".
 *
 * Retire used to die on that too, on its own status probe, which took the agent out of the archive batch and
 * left the board answering "nothing to archive" about a card sitting right there, forever: the only exit a
 * finished conversation has, closed for good by a repo the user removed months later.
 *
 * There is nothing to preserve here and no way to preserve it, so retiring reclaims what it can and says so in
 * the log. The repos that still HAVE a repository behind them are preserved exactly as ever, which is the half
 * that must not be traded away for the other. */
test("retire reclaims a checkout whose repository was deleted from the workspace, and still preserves the rest", async () => {
    const { work, worktrees } = await setup();
    // A repo the USER cloned into the workspace, so its git dir lives inside it rather than on /history: that
    // is the case that can dangle, because deleting the directory deletes the admin area too.
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
    // Root's work still reached its branch: the dead nested repo cost the archive nothing but itself.
    expect(await sh(work, "show", "agent/c1:new-file.md")).toBe("agent file");
});

test("retire is a no-op on a clean worktree beyond dropping the checkout", async () => {
    const { work, worktrees } = await setup();
    const conversation = await worktrees.ensure("c1", []);
    const tip = await sh(work, "rev-parse", "agent/c1");

    await worktrees.retire("c1", conversation.repos, "nothing to do");

    expect(existsSync(conversation.cwd)).toBe(false);
    // No empty "Agent:" commit: the branch still points where it did.
    expect(await sh(work, "rev-parse", "agent/c1")).toBe(tip);
});

// PARKING: the ref half of retiring. What archiving costs a repo used to include one refs/heads/ entry per
// conversation forever; these pin the shape that removed it without the caller noticing.
test("retire takes the branch off refs/heads and ensure puts it back", async () => {
    const { work, worktrees } = await setup();
    const created = await worktrees.ensure("c1", []);
    await writeFile(join(created.cwd, "new-file.md"), "agent file\n");
    const tip = await sh(work, "rev-parse", "agent/c1");

    await worktrees.retire("c1", created.repos, undefined);

    // Off refs/heads: for both repos of the composition, which is where the count came from.
    expect(await sh(work, "for-each-ref", "--format=%(refname)", "refs/heads/agent/")).toBe("");
    expect(await sh(join(work, "intent"), "for-each-ref", "--format=%(refname)", "refs/heads/agent/")).toBe("");
    // But still named by exactly the string every caller holds as entry.branch, and still the same commits
    // plus the one retire made, so land, the review diff and every standing keep reading it unchanged.
    expect(await sh(work, "rev-parse", "refs/agent/c1")).toBe(await sh(work, "rev-parse", "agent/c1"));
    expect(await sh(work, "merge-base", "--is-ancestor", tip, "agent/c1")).toBe("");
    expect(await sh(work, "show", "agent/c1:new-file.md")).toBe("agent file");

    // Resuming is the inverse, and the user is owed a real branch: a detached checkout would drop the turn's
    // commits on the floor.
    const restored = await worktrees.ensure("c1", created.repos);
    expect(await sh(restored.cwd, "branch", "--show-current")).toBe("agent/c1");
    expect(await sh(work, "for-each-ref", "--format=%(refname)", "refs/agent/")).toBe("");
    expect(await readFile(join(restored.cwd, "new-file.md"), "utf8")).toBe("agent file\n");
});

test("prune parks the branches of agents that are off the board and drops refs no entry claims", async () => {
    const { work, worktrees } = await setup();
    const archived = await worktrees.ensure("c1", []);
    await worktrees.ensure("c2", []);
    // An archive taken before parking existed: the checkout is gone but the branch is still a branch.
    await worktrees.retire("c1", archived.repos, undefined);
    await sh(work, "branch", "agent/c1", "refs/agent/c1");
    await sh(work, "update-ref", "-d", "refs/agent/c1");
    // And a parked ref whose conversation the registry has forgotten entirely.
    await sh(work, "update-ref", "refs/agent/ghost", await sh(work, "rev-parse", "HEAD"));

    await worktrees.prune(
        () => ["c1", "c2"],
        () => ["c1"],
    );

    // c1 converges onto the shelf; c2 is live and keeps its branch: the sweep never touches a checked-out one.
    expect(await sh(work, "for-each-ref", "--format=%(refname:short)", "refs/heads/agent/")).toBe("agent/c2");
    expect(await sh(work, "rev-parse", "-q", "--verify", "refs/agent/c1")).not.toBe("");
    // The orphan goes: nothing left in the fleet can ever reach those commits again.
    await expect(sh(work, "rev-parse", "-q", "--verify", "refs/agent/ghost")).rejects.toThrow();
});

test("remove drops a parked agent's commits, not just its branch", async () => {
    const { work, worktrees } = await setup();
    const created = await worktrees.ensure("c1", []);
    await worktrees.retire("c1", created.repos, undefined);

    // Discarding an ARCHIVED agent: `branch -D` alone would find nothing and leave the shelf ref behind.
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

/* The revert-by-checkout the sparse rule exists to stop (worktrees.ts excludeSharedState).
 *
 * `.intentic` is ONE directory shared by every conversation (isolation.ts binds it over each worktree), and
 * part of it is tracked. Before the exclusion, a worktree whose branch predated a config change would put its
 * own committed copy back on any checkout — through the bind, over the live file — and commit it from there.
 * Both halves are asserted: the state dir never reaches the checkout, and the versioned entry is still in the
 * branch's index, so landing a config change from the main tree is unaffected.
 */
test("the shared state dir is kept out of an agent's checkout, while its versioned entries stay in the index", async () => {
    const { work, worktrees } = await setup();
    const versioned = join(work, ".intentic", "config", "settings.json");
    await mkdir(join(work, ".intentic", "config"), { recursive: true });
    await writeFile(versioned, '{"model":"v1"}\n');
    await sh(work, "add", "-A", "--force", ".intentic/config/settings.json");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "config v1");

    const conversation = await worktrees.ensure("c1", []);

    // Not on disk in the worktree: the bind mount, not the checkout, is what puts a state dir at this path.
    expect(existsSync(join(conversation.cwd, ".intentic", "config", "settings.json"))).toBe(false);
    // Still tracked on the branch, carrying git's skip-worktree bit rather than having been deleted.
    expect(await sh(conversation.cwd, "rev-parse", "HEAD:.intentic/config/settings.json")).toBe(
        await sh(work, "rev-parse", "HEAD:.intentic/config/settings.json"),
    );
    expect(await sh(conversation.cwd, "ls-files", "-v", ".intentic/config/settings.json")).toMatch(/^S /);
    // And the worktree reports nothing to commit, so a retire/land `add -A` cannot sweep a stale copy back.
    expect(await sh(conversation.cwd, "status", "--short")).toBe("");
});

// The main line moving a versioned entry must still reach the branch: the whole point of sparse-checkout over a
// bare skip-worktree bit is that a rebase updates the index for a path it never writes to disk.
test("a rebase carries a config change the worktree never checks out", async () => {
    const { work, worktrees } = await setup();
    await mkdir(join(work, ".intentic", "config"), { recursive: true });
    await writeFile(join(work, ".intentic", "config", "settings.json"), '{"model":"v1"}\n');
    await sh(work, "add", "-A", "--force", ".intentic/config/settings.json");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "config v1");
    const conversation = await worktrees.ensure("c1", []);

    await writeFile(join(work, ".intentic", "config", "settings.json"), '{"model":"v2"}\n');
    await sh(work, "add", "-A", "--force", ".intentic/config/settings.json");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "config v2");
    await sh(conversation.cwd, "-c", "user.name=t", "-c", "user.email=t@t", "rebase", "main");

    expect(await sh(conversation.cwd, "rev-parse", "HEAD:.intentic/config/settings.json")).toBe(
        await sh(work, "rev-parse", "HEAD:.intentic/config/settings.json"),
    );
    expect(existsSync(join(conversation.cwd, ".intentic", "config", "settings.json"))).toBe(false);
});

/* THE CONVERGENCE GUARD'S OWN TRAP, and why it reads the pattern file rather than the config flag.
 *
 * `info/sparse-checkout` is per-worktree, but `core.sparseCheckout` is repo config, SHARED by every worktree
 * unless `extensions.worktreeConfig` is on — and it is not. A guard that read the flag was therefore satisfied
 * by a SIBLING's work: the first worktree to converge set it repo-wide, and every worktree created after that
 * read `true`, returned early, and never wrote a pattern of its own. Sparse checkout nominally on, no pattern,
 * nothing excluded, the state dir fully live in `git status` — which is how one conversation's in-flight edit
 * to a workspace extension ended up inside another conversation's land, under an unrelated subject.
 *
 * ONE worktree cannot catch this; the first one always passes. The second is the regression.
 */
test("a second conversation's worktree excludes the state dir too, though the first already set the shared flag", async () => {
    const { work, worktrees } = await setup();
    await mkdir(join(work, ".intentic", "config"), { recursive: true });
    await writeFile(join(work, ".intentic", "config", "settings.json"), '{"model":"v1"}\n');
    await sh(work, "add", "-A", "--force", ".intentic/config/settings.json");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "config v1");

    const first = await worktrees.ensure("c1", []);
    const second = await worktrees.ensure("c2", []);

    // The flag the old guard keyed off is repo-wide once the first worktree has converged. That is the trap the
    // second worktree has to survive, so assert it is genuinely set rather than assuming it.
    expect(await sh(second.cwd, "config", "--get", "core.sparseCheckout")).toBe("true");

    for (const cwd of [first.cwd, second.cwd]) {
        // Each worktree carries a pattern of its OWN: a sibling's file is not this worktree's exclusion.
        expect(existsSync(join(cwd, ".intentic", "config", "settings.json"))).toBe(false);
        expect(await sh(cwd, "ls-files", "-v", ".intentic/config/settings.json")).toMatch(/^S /);
        // The half that actually bit: a land's `add -A` must find nothing of the shared tree to sweep up.
        expect(await sh(cwd, "status", "--short")).toBe("");
    }
});
