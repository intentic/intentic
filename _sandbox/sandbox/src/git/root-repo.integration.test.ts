import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { STATE_DIR } from "@intentic/constants";
import { afterEach, expect, test } from "vitest";
import { rootExcludes } from "../history/history.js";
import { workspacePaths } from "../workspace/workspace.js";
import { changedFiles } from "./changes.js";
import { commitRootBaseline, commitWorktreeRemainder, ensureLocalRootRepo, ensureRootRepo } from "./root-repo.js";

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();

// These assertions only care that the tree is clean overall — which side a change would have landed on is
// changes.integration.test.ts's subject, not this file's.
const bothSides = async (dir: string): Promise<unknown[]> => {
    const { staged, unstaged } = await changedFiles(dir);
    return [...staged, ...unstaged];
};

const tempDirs: string[] = [];
const tempBase = async (): Promise<{ work: string; historyRoot: string }> => {
    const base = await mkdtemp(join(tmpdir(), "intentic-root-repo-"));
    tempDirs.push(base);
    const work = join(base, "work");
    await mkdir(work, { recursive: true });
    return { work, historyRoot: join(base, "history") };
};
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

test("provision inits /work with a separate git dir, a baseline commit, and the history exclude list", async () => {
    const { work, historyRoot } = await tempBase();
    await writeFile(join(work, "notes.md"), "hello\n");
    await mkdir(join(work, "intent", ".git"), { recursive: true });
    await writeFile(join(work, "intent", "deploy.config.ts"), "v1\n");
    await mkdir(join(work, `${STATE_DIR}`), { recursive: true });
    await writeFile(join(work, `${STATE_DIR}`, "owner.json"), "{}\n");

    expect(await ensureRootRepo(workspacePaths(work), historyRoot)).toBe(true);
    await commitRootBaseline(workspacePaths(work));

    // Pointer file in the worktree, real git dir on the history volume, excludes converged from the
    // discovered repo set.
    expect(await readFile(join(work, ".git"), "utf8")).toBe(`gitdir: ${join(historyRoot, "gits", "root")}\n`);
    expect(await readFile(join(historyRoot, "gits", "root", "info", "exclude"), "utf8")).toBe(`${rootExcludes(["intent"]).join("\n")}\n`);
    // The baseline commit captured the loose file but neither the repo dir nor .intentic/.
    expect(await sh(work, "ls-files")).toBe("notes.md");
    expect(await bothSides(work)).toEqual([]);
});

/* THE HOLES IN THE .intentic WALL, checked against real git rather than reasoned about.
 *
 * The owner's CONFIGURATION is committed on purpose — a persona or an automation should be addable in a pull
 * request and visible in `git log` — while the credentials, ledgers and transcripts beside it must never be. The
 * rule turns on a single character of git syntax: the exclude names the directory's CONTENTS (`/.intentic/*`)
 * rather than the directory, because git does not descend into an excluded directory and a `!` negation under
 * one re-includes nothing at all. Get that wrong in the safe direction and settings silently never commit; get
 * it wrong in the other and the next baseline commits the owner's provider tokens. Neither failure announces
 * itself, so the assertion is on git's own answer.
 *
 * The directory carve-out (environment.d/) is here for the same reason: re-including a DIRECTORY is what lets
 * git walk into it, and it is the negation whose trailing slash has to survive the mapping in history.ts —
 * checked here on the NESTED case too (an extension is a directory inside a carved-out directory), because that
 * is the shape a `*` glob written one level too shallow would silently drop. */
test("the baseline commits the config slice and still refuses every credential and ledger beside it", async () => {
    const { work, historyRoot } = await tempBase();
    await mkdir(join(work, `${STATE_DIR}`, "browser", "reddit-work"), { recursive: true });
    await mkdir(join(work, `${STATE_DIR}`, "auth", "claude"), { recursive: true });
    await mkdir(join(work, `${STATE_DIR}`, "environment.d"), { recursive: true });
    await mkdir(join(work, `${STATE_DIR}`, "sessions", "claude"), { recursive: true });
    await mkdir(join(work, `${STATE_DIR}`, "drafts"), { recursive: true });
    await mkdir(join(work, `${STATE_DIR}`, "workspace-extensions", "rail-demo"), { recursive: true });
    await mkdir(join(work, `${STATE_DIR}`, "approvals"), { recursive: true });
    // Configuration — every one of these decides how the sandbox behaves, and each is `versioned` in the contract.
    await writeFile(join(work, `${STATE_DIR}`, "personas.json"), `[{"id":"work","capabilities":["reddit-work"]}]\n`);
    await writeFile(join(work, `${STATE_DIR}`, "settings.json"), "{}\n");
    await writeFile(join(work, `${STATE_DIR}`, "automations.json"), "[]\n");
    await writeFile(join(work, `${STATE_DIR}`, "environment.custom.Dockerfile"), "RUN echo hi\n");
    await writeFile(join(work, `${STATE_DIR}`, "environment.d", "rust.Dockerfile"), "RUN rustup\n");
    /* What the AGENT authored on its own initiative — tracked for a different reason than the config above it:
     * not "the owner decided this" but "the sandbox did this outward, and it must be readable, revertible and
     * attributable". The extension is the nested-directory case, and its manifest is what decides how far its
     * code may reach, so the two files together are the whole review. */
    await writeFile(join(work, `${STATE_DIR}`, "drafts", "reddit-launch.json"), `{"platform":"reddit","status":"proposed"}\n`);
    await writeFile(join(work, `${STATE_DIR}`, "workspace-extensions", "rail-demo", "extension.js"), "export const activate = () => {};\n");
    await writeFile(join(work, `${STATE_DIR}`, "workspace-extensions", "rail-demo", "intentic-extension.json"), `{"name":"rail-demo"}\n`);
    // A CONSUMED QUEUE beside them, and the counterexample that keeps the line honest: a held wake is removed the
    // moment it is answered, so tracking it would commit an add and a delete about a decision recorded elsewhere.
    await writeFile(join(work, `${STATE_DIR}`, "approvals", "wake-1.json"), "{}\n");
    /* WHAT THIS SANDBOX IS CONNECTED TO — tracked, and the entry that reads most like a credential without being
     * one. The values are in the vault off /work and the manifest keeps the shape (an id, a kind, an address);
     * granting a connected computer shell access is a decision, and it belongs in the same review as the rules
     * that decide how the agent behaves. */
    await writeFile(join(work, `${STATE_DIR}`, "capabilities.json"), `[{"id":"reddit-work","kind":"browser","config":{}}]\n`);
    // Credentials and identity — never tracked, whatever else changes.
    await writeFile(join(work, `${STATE_DIR}`, "owner.json"), "{}\n");
    await writeFile(join(work, `${STATE_DIR}`, "auth", "claude", "token.json"), "{}\n");
    await writeFile(join(work, `${STATE_DIR}`, "browser", "reddit-work", "Cookies"), "secret\n");
    // Ledgers and bulk — `carry`, holding no secret, and still out: they are machine noise in a human's review.
    await writeFile(join(work, `${STATE_DIR}`, "workflow-runs.json"), "[]\n");
    await writeFile(join(work, `${STATE_DIR}`, "loops.json"), "[]\n");
    await writeFile(join(work, `${STATE_DIR}`, "sessions", "claude", "turn.jsonl"), "{}\n");

    expect(await ensureRootRepo(workspacePaths(work), historyRoot)).toBe(true);
    await commitRootBaseline(workspacePaths(work));

    // Exactly the tracked slice out of that directory — both directory carve-outs included, nothing else.
    expect((await sh(work, "ls-files")).split("\n")).toEqual([
        ".intentic/automations.json",
        ".intentic/capabilities.json",
        ".intentic/drafts/reddit-launch.json",
        ".intentic/environment.custom.Dockerfile",
        ".intentic/environment.d/rust.Dockerfile",
        ".intentic/personas.json",
        ".intentic/settings.json",
        ".intentic/workspace-extensions/rail-demo/extension.js",
        ".intentic/workspace-extensions/rail-demo/intentic-extension.json",
    ]);
    // Nothing left over: the credentials and ledgers are IGNORED, not merely uncommitted-and-pending.
    expect(await bothSides(work)).toEqual([]);
});

test("daemon-owned skill files converged before the baseline read clean", async () => {
    const { work, historyRoot } = await tempBase();

    expect(await ensureRootRepo(workspacePaths(work), historyRoot)).toBe(true);
    // The boot sequence converges .agents skills (e.g. the drafts skill) BEFORE committing the baseline.
    await mkdir(join(work, ".agents", "skills", "drafts"), { recursive: true });
    await writeFile(join(work, ".agents", "skills", "drafts", "SKILL.md"), "converged\n");
    await commitRootBaseline(workspacePaths(work));

    expect(await sh(work, "ls-files")).toBe(".agents/skills/drafts/SKILL.md");
    expect(await bothSides(work)).toEqual([]);
});

// A repo dir that reached root's index — the shape the exclude list can no longer act on. `add -f` is how it
// happens for real: a clone staged before the derived exclude list caught up with it, or an agent's own forced
// add, committed by whoever reviewed the workspace next.
const trackNestedRepo = async (work: string, repo: string): Promise<void> => {
    await sh(work, "add", "-f", "-A", "--", repo);
    await sh(work, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "fix: migration");
};
const nestedRepo = async (work: string, repo: string): Promise<string> => {
    const dir = join(work, repo);
    await mkdir(dir, { recursive: true });
    await sh(dir, "init", "-q", "--initial-branch=main");
    await writeFile(join(dir, "app.ts"), "v1\n");
    await sh(dir, "add", "-A");
    await sh(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "one");
    return dir;
};
const commitInNested = async (dir: string): Promise<string> => {
    await writeFile(join(dir, "app.ts"), "v2\n");
    await sh(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-aq", "-m", "two");
    return sh(dir, "rev-parse", "HEAD");
};

test("a nested repo tracked in root's index is untracked and the removal committed", async () => {
    const { work, historyRoot } = await tempBase();
    const nested = await nestedRepo(work, "intent");
    await ensureRootRepo(workspacePaths(work), historyRoot);
    await commitRootBaseline(workspacePaths(work));
    await trackNestedRepo(work, "intent");
    const head = await commitInNested(nested);
    // The bug: excluding a path git already tracks does nothing, so the nested HEAD move surfaces in root.
    expect(await bothSides(work)).toMatchObject([{ path: "intent", status: "modified" }]);

    expect(await ensureRootRepo(workspacePaths(work), historyRoot)).toBe(false);

    // Gone from the index AND from the commit, so no later HEAD move can bring it back.
    expect(await sh(work, "ls-files")).toBe("");
    expect(await sh(work, "ls-tree", "--name-only", "HEAD")).toBe("");
    expect(await bothSides(work)).toEqual([]);
    expect(await sh(work, "log", "--format=%s")).toBe("chore: untrack nested repositories\nfix: migration\nInitialize workspace");
    // The repo itself is untouched — same checkout, same HEAD.
    expect(await sh(nested, "rev-parse", "HEAD")).toBe(head);
    expect(await readFile(join(nested, "app.ts"), "utf8")).toBe("v2\n");
});

test("untracking a nested repo leaves the user's own staged work staged, and out of the commit", async () => {
    const { work, historyRoot } = await tempBase();
    await writeFile(join(work, "notes.md"), "hello\n");
    await nestedRepo(work, "intent");
    await ensureRootRepo(workspacePaths(work), historyRoot);
    await commitRootBaseline(workspacePaths(work));
    await trackNestedRepo(work, "intent");
    await writeFile(join(work, "notes.md"), "staged edit\n");
    await sh(work, "add", "notes.md");

    await ensureRootRepo(workspacePaths(work), historyRoot);

    // Still staged, and the housekeeping commit recorded only the removal.
    expect(await sh(work, "diff", "--cached", "--name-only")).toBe("notes.md");
    expect(await sh(work, "show", "--format=", "--name-status", "HEAD")).toBe("D\tintent");
});

// A conversation's own checkout of root, the shape agents/worktrees.ts creates it in.
const agentWorktree = async (work: string, branch: string): Promise<string> => {
    const dir = join(dirname(work), branch);
    await sh(work, "worktree", "add", "-q", "-b", branch, dir);
    return dir;
};

test("a conversation's root worktree stages a nested repo but never commits one", async () => {
    const { work, historyRoot } = await tempBase();
    await ensureRootRepo(workspacePaths(work), historyRoot);
    await commitRootBaseline(workspacePaths(work));
    const worktree = await agentWorktree(work, "agent-one");
    // A repo the derived exclude list cannot name: the agent cloned it into its own tree, so the main checkout
    // discovery reads has never seen it.
    await nestedRepo(worktree, "intent");
    await writeFile(join(worktree, "notes.md"), "agent work\n");

    expect(await commitWorktreeRemainder("root", worktree, "Agent: one")).toBe(true);

    expect(await sh(worktree, "show", "--format=", "--name-status", "HEAD")).toBe("A\tnotes.md");
    expect(await sh(worktree, "ls-files")).toBe("notes.md");
    // The checkout is untouched — the repo is still there, still its own.
    expect(await readFile(join(worktree, "intent", "app.ts"), "utf8")).toBe("v1\n");
});

test("a nested repo a past turn committed is dropped, and the review's span comes back clean", async () => {
    const { work, historyRoot } = await tempBase();
    await ensureRootRepo(workspacePaths(work), historyRoot);
    await commitRootBaseline(workspacePaths(work));
    const worktree = await agentWorktree(work, "agent-one");
    const nested = await nestedRepo(worktree, "intent");
    // The bug as the branch already carries it: a one-line `+1` add for the repo, back on every land as the
    // repo's own HEAD moves.
    await trackNestedRepo(worktree, "intent");
    await commitInNested(nested);
    expect(await sh(worktree, "diff", "--name-only", "main")).toBe("intent");

    await writeFile(join(worktree, "notes.md"), "agent work\n");
    expect(await commitWorktreeRemainder("root", worktree, "Agent: one")).toBe(true);

    // Added and removed inside this branch, so anchor→tip — what the agent's review reads — has no row for it.
    expect(await sh(worktree, "diff", "--name-only", "main")).toBe("notes.md");
    expect(await sh(worktree, "show", "--format=", "--name-status", "HEAD")).toBe("D\tintent\nA\tnotes.md");
});

test("a NESTED repo of the composition keeps a gitlink of its own — that one is the user's submodule", async () => {
    const { work, historyRoot } = await tempBase();
    await ensureRootRepo(workspacePaths(work), historyRoot);
    const app = await nestedRepo(work, "app");
    await nestedRepo(app, "vendor");

    expect(await commitWorktreeRemainder("app", app, "Agent: one")).toBe(true);

    expect(await sh(app, "ls-files")).toBe("app.ts\nvendor");
});

test("re-ensure is idempotent and heals a deleted .git pointer without a new baseline", async () => {
    const { work, historyRoot } = await tempBase();
    expect(await ensureRootRepo(workspacePaths(work), historyRoot)).toBe(true);
    await commitRootBaseline(workspacePaths(work));
    const head = await sh(work, "rev-parse", "HEAD");

    await rm(join(work, ".git"));
    expect(await ensureRootRepo(workspacePaths(work), historyRoot)).toBe(false);
    expect(await sh(work, "rev-parse", "HEAD")).toBe(head);
    expect(await sh(work, "log", "--format=%s")).toBe("Initialize workspace");
});

// A gitlink DECLARED in .gitmodules is the user's own submodule, not the accident the convergence exists to
// undo — see strayGitlinks. `git submodule add` needs the file protocol re-allowed (git 2.38 closed it).
const declareSubmodule = async (work: string, source: string, path: string): Promise<void> => {
    await sh(work, "-c", "protocol.file.allow=always", "submodule", "add", "-q", source, path);
    await sh(work, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "feat: add submodule");
};

test("a declared submodule survives the untrack convergence; a stray gitlink beside it does not", async () => {
    const { work, historyRoot } = await tempBase();
    const { work: elsewhere } = await tempBase();
    const upstream = await nestedRepo(elsewhere, "lib");
    await ensureRootRepo(workspacePaths(work), historyRoot);
    await commitRootBaseline(workspacePaths(work));
    await declareSubmodule(work, upstream, "lib");
    await nestedRepo(work, "intent");
    await trackNestedRepo(work, "intent");

    expect(await ensureRootRepo(workspacePaths(work), historyRoot)).toBe(false);

    // The submodule keeps its gitlink and its .gitmodules line; the stray is gone from index and commit.
    expect(await sh(work, "ls-files")).toBe(".gitmodules\nlib");
    expect(await sh(work, "ls-tree", "--name-only", "HEAD")).toBe(".gitmodules\nlib");
});

test("a conversation's root worktree commit spares declared submodules too", async () => {
    const { work, historyRoot } = await tempBase();
    const { work: elsewhere } = await tempBase();
    const upstream = await nestedRepo(elsewhere, "lib");
    await ensureRootRepo(workspacePaths(work), historyRoot);
    await commitRootBaseline(workspacePaths(work));
    await declareSubmodule(work, upstream, "lib");
    await nestedRepo(work, "stray");
    await writeFile(join(work, "notes.md"), "the turn's own work\n");

    expect(await commitWorktreeRemainder("root", work, "Agent: one")).toBe(true);

    const listed = await sh(work, "ls-files");
    expect(listed).toContain("lib");
    expect(listed).not.toContain("stray");
});

// ——— the LOCAL profile's ensure: the folder is the user's own ———

test("local ensure of a folder that is not a repo inits in-tree, excludes state, and takes a baseline", async () => {
    const { work } = await tempBase();
    await writeFile(join(work, "notes.md"), "hello\n");
    await nestedRepo(work, "service");

    expect(await ensureLocalRootRepo(workspacePaths(work))).toBe(true);
    await commitRootBaseline(workspacePaths(work));

    // A real in-tree git dir — nothing relocated, no pointer file.
    expect(await sh(work, "rev-parse", "--git-dir")).toBe(".git");
    // The discovered nested repo and the daemon's own furniture stay out of the baseline.
    expect(await sh(work, "ls-files")).toBe("notes.md");
    const excludes = await readFile(join(work, ".git", "info", "exclude"), "utf8");
    expect(excludes).toContain("/service/");
    expect(excludes).toContain(`/${STATE_DIR}/`);
});

test("local ensure takes an existing repo exactly as it stands, appending only the state excludes", async () => {
    const { work } = await tempBase();
    const dir = await nestedRepo(work, "theirs");
    await writeFile(join(dir, ".git", "info", "exclude"), "# mine\n*.scratch\n");
    const head = await sh(dir, "rev-parse", "HEAD");

    expect(await ensureLocalRootRepo(workspacePaths(dir))).toBe(false);
    expect(await ensureLocalRootRepo(workspacePaths(dir))).toBe(false);

    // No init, no commit, no reshaping — and the user's own exclude lines survive, grown once.
    expect(await sh(dir, "rev-parse", "HEAD")).toBe(head);
    expect(await sh(dir, "log", "--format=%s")).toBe("one");
    const excludes = await readFile(join(dir, ".git", "info", "exclude"), "utf8");
    expect(excludes).toContain("# mine\n*.scratch\n");
    expect(excludes.match(new RegExp(`/${STATE_DIR}/`, "g"))).toHaveLength(1);
});

test("local ensure never converges a pre-existing repo's gitlinks — submodules are the user's", async () => {
    const { work } = await tempBase();
    const { work: elsewhere } = await tempBase();
    const upstream = await nestedRepo(elsewhere, "lib");
    const dir = await nestedRepo(work, "theirs");
    await declareSubmodule(dir, upstream, "lib");

    expect(await ensureLocalRootRepo(workspacePaths(dir))).toBe(false);

    expect(await sh(dir, "ls-files")).toBe(".gitmodules\napp.ts\nlib");
});
