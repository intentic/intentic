import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createLogger } from "../logger.js";
import { workspacePaths } from "../workspace/workspace.js";
import { createWorkspaceHistory } from "./history.js";
import { freeGitDirFor } from "../workspace/layout/git-dir-owners.js";
import { repoGitDir } from "../workspace/layout/git-layout.js";

// A git dir on /history belongs to every checkout whose `.git` leads to it, not to the folder whose name it carries.
// Each case below is a second checkout of one git dir (a copied folder, a renamed one, `git worktree add`, a delete
// undone from the file view's trash) that the reaper used to orphan by going by that name alone.

const exec = promisify(execFile);
const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

const setup = async () => {
    const base = await mkdtemp(join(tmpdir(), "intentic-git-owners-"));
    tempDirs.push(base);
    const work = join(base, "work");
    const historyRoot = join(base, "history");
    await mkdir(join(historyRoot, "gits"), { recursive: true });
    const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
    const makeRepo = async (name: string): Promise<string> => {
        const dir = join(work, name);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "readme.md"), "v1\n");
        await sh(dir, "init", "-q", "--initial-branch=main", "--separate-git-dir", repoGitDir(historyRoot, name));
        await sh(dir, "add", "-A");
        await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
        await sh(dir, "remote", "add", "origin", "https://example.com/acme/app.git");
        return dir;
    };
    // What a user's own git says in that checkout: the remote, or git's refusal.
    const origin = async (dir: string): Promise<string> => sh(dir, "remote", "get-url", "origin").catch((error: { stderr?: string }) => `refused: ${error.stderr?.trim()}`);
    const pointer = async (dir: string): Promise<string> => (await readFile(join(dir, ".git"), "utf8")).trim();
    const history = createWorkspaceHistory({ workspace: workspacePaths(work), historyRoot, logger });
    return { work, historyRoot, sh, makeRepo, origin, pointer, history };
};

test("a copied checkout keeps working once the original is deleted", async () => {
    const { work, historyRoot, makeRepo, origin, pointer, history } = await setup();
    const first = await makeRepo("app");
    const second = join(work, "app-2");
    await cp(first, second, { recursive: true });

    await history.snapshot("interval");
    // The copy got a git dir of its own: a commit or checkout in one no longer moves the other's HEAD and index.
    expect(await pointer(second)).toBe(`gitdir: ${repoGitDir(historyRoot, "app-2")}`);
    expect(await pointer(first)).toBe(`gitdir: ${repoGitDir(historyRoot, "app")}`);

    await rm(first, { recursive: true, force: true });
    await history.snapshot("interval");
    expect(existsSync(repoGitDir(historyRoot, "app"))).toBe(false);
    expect(await origin(second)).toBe("https://example.com/acme/app.git");
});

test("a copy whose original goes in the same cycle takes over the git dir under its own name", async () => {
    const { work, historyRoot, makeRepo, origin, pointer, history } = await setup();
    const first = await makeRepo("app");
    const second = join(work, "app-2");
    await cp(first, second, { recursive: true });
    await rm(first, { recursive: true, force: true });

    await history.snapshot("interval");
    expect(await pointer(second)).toBe(`gitdir: ${repoGitDir(historyRoot, "app-2")}`);
    expect(existsSync(repoGitDir(historyRoot, "app"))).toBe(false);
    expect(await origin(second)).toBe("https://example.com/acme/app.git");
});

test("a renamed checkout takes its git dir along", async () => {
    const { work, historyRoot, sh, makeRepo, origin, pointer, history } = await setup();
    const dir = await makeRepo("app");
    const renamed = join(work, "client-app");
    await rename(dir, renamed);

    await history.snapshot("interval");
    expect(await pointer(renamed)).toBe(`gitdir: ${repoGitDir(historyRoot, "client-app")}`);
    expect(existsSync(repoGitDir(historyRoot, "app"))).toBe(false);
    expect(await origin(renamed)).toBe("https://example.com/acme/app.git");
    expect(await sh(renamed, "log", "--format=%s")).toBe("init");
    // Nothing went to the trash: it was moved, not deleted.
    expect(await readdir(join(historyRoot, "trash")).catch(() => [])).toEqual([]);
});

test("a linked worktree keeps its repository when the main checkout is deleted", async () => {
    const { work, historyRoot, sh, makeRepo, origin, history } = await setup();
    const dir = await makeRepo("app");
    const linked = join(work, "app-feature");
    await sh(dir, "worktree", "add", "-q", "-b", "feature", linked);
    await rm(dir, { recursive: true, force: true });

    await history.snapshot("interval");
    expect(existsSync(repoGitDir(historyRoot, "app"))).toBe(true);
    expect(await origin(linked)).toBe("https://example.com/acme/app.git");
});

test("a deleted checkout brought back from the trash finds its git dir again", async () => {
    const { work, historyRoot, makeRepo, origin, history } = await setup();
    const dir = await makeRepo("app");
    const aside = join(work, "..", "file-view-trash");
    await rename(dir, aside);
    await history.snapshot("interval");
    expect(existsSync(repoGitDir(historyRoot, "app"))).toBe(false);

    await rename(aside, dir);
    await history.snapshot("interval");
    expect(existsSync(repoGitDir(historyRoot, "app"))).toBe(true);
    expect(await origin(dir)).toBe("https://example.com/acme/app.git");
});

test("a deleted repo is still reaped when nothing else points at its git dir", async () => {
    const { historyRoot, makeRepo, history } = await setup();
    const keep = await makeRepo("keep");
    const gone = await makeRepo("gone");
    await rm(gone, { recursive: true, force: true });

    await history.snapshot("interval");
    expect(existsSync(repoGitDir(historyRoot, "gone"))).toBe(false);
    expect(existsSync(repoGitDir(historyRoot, "keep"))).toBe(true);
    expect(existsSync(keep)).toBe(true);
    expect((await readdir(join(historyRoot, "trash"))).some((entry) => entry.startsWith("gone-"))).toBe(true);
});

test("a copy leaves the original's linked worktrees registered with the original alone", async () => {
    const { work, historyRoot, sh, makeRepo, history } = await setup();
    const first = await makeRepo("app");
    // A conversation's checkout of the repo, outside /work as the daemon keeps them.
    const conversation = join(work, "..", "conversation-app");
    await sh(first, "worktree", "add", "-q", "-b", "agent/x", conversation);
    const second = join(work, "app-2");
    await cp(first, second, { recursive: true });

    await history.snapshot("interval");
    expect(existsSync(join(repoGitDir(historyRoot, "app-2"), "worktrees"))).toBe(false);
    expect(await sh(second, "branch", "--format=%(refname:short)")).toContain("agent/x");
    expect(await sh(conversation, "rev-parse", "--abbrev-ref", "HEAD")).toBe("agent/x");
});

test("a renamed checkout's linked worktrees follow its git dir", async () => {
    const { work, historyRoot, sh, makeRepo, history } = await setup();
    const dir = await makeRepo("app");
    const conversation = join(work, "..", "conversation-app");
    await sh(dir, "worktree", "add", "-q", "-b", "agent/x", conversation);
    await rename(dir, join(work, "client-app"));

    await history.snapshot("interval");
    expect(await sh(conversation, "rev-parse", "--absolute-git-dir")).toBe(join(repoGitDir(historyRoot, "client-app"), "worktrees", "conversation-app"));
    expect(await sh(conversation, "rev-parse", "--abbrev-ref", "HEAD")).toBe("agent/x");
});

test("a folder cloned again over an old name lets the old git dir go", async () => {
    const { work, historyRoot, sh, history } = await setup();
    // The first clone's git dir, its folder since replaced by a terminal clone with an in-tree `.git`.
    await mkdir(join(repoGitDir(historyRoot, "app"), "refs"), { recursive: true });
    const dir = join(work, "app");
    await mkdir(dir, { recursive: true });
    await sh(dir, "init", "-q");
    await writeFile(join(dir, "readme.md"), "v1\n");

    await history.snapshot("interval");
    expect(existsSync(repoGitDir(historyRoot, "app"))).toBe(false);
    expect((await readdir(join(historyRoot, "trash"))).some((entry) => entry.startsWith("app-"))).toBe(true);
});

test("a new repository's name is freed of a git dir nothing uses, and refused while a checkout still does", async () => {
    const { work, historyRoot, makeRepo } = await setup();
    const deps = { workspaceRoot: work, historyRoot, logger };
    await mkdir(join(repoGitDir(historyRoot, "stale"), "refs"), { recursive: true });
    expect(await freeGitDirFor(deps, [], "stale")).toBeUndefined();
    expect(existsSync(repoGitDir(historyRoot, "stale"))).toBe(false);

    const first = await makeRepo("app");
    await cp(first, join(work, "app-2"), { recursive: true });
    await rm(first, { recursive: true, force: true });
    expect(await freeGitDirFor(deps, ["app-2"], "app")).toBe("app-2");
    expect(existsSync(repoGitDir(historyRoot, "app"))).toBe(true);
});
