import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { type GitRunner, reportGitFailure } from "@intentic/base/git";
import { clearManifestProblems, manifestProblems } from "../../store/manifest/manifest-problems.js";
import { checkGitIntegrity, integrityCardPath, passInFlight, resetGitIntegrity, startGitIntegrity } from "./crash-check.js";
import { looseObjectSound } from "./loose-objects.js";
import { repairRepo } from "./repo-repair.js";

// Real git over a real disk: the damage is a loose object's file with its size and none of its bytes, which is what
// rog's crash left in /history/gits/root on 10-30, and what git itself has to be asked about afterwards.

const exec = promisify(execFile);
const git: GitRunner = async (dir, args) => exec("git", ["-C", dir, ...args]);
const sh = async (dir: string, ...args: string[]): Promise<string> => (await git(dir, args)).stdout.trim();
const quiet = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

const tempDirs: string[] = [];
afterEach(async () => {
    resetGitIntegrity();
    clearManifestProblems();
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

// A workspace whose root is a repo with a linked worktree, as a conversation's checkout is.
const workspace = async (): Promise<{ root: string; historyRoot: string; worktree: string }> => {
    const base = await mkdtemp(join(tmpdir(), "git-integrity-"));
    tempDirs.push(base);
    const root = join(base, "work");
    const historyRoot = join(base, "history");
    const worktree = join(base, "wt");
    await mkdir(root, { recursive: true });
    await mkdir(historyRoot, { recursive: true });
    await sh(root, "init", "-q", "-b", "main");
    await sh(root, "config", "user.email", "t@example.com");
    await sh(root, "config", "user.name", "t");
    await writeFile(join(root, "kept.rs"), "fn kept() {}\n");
    await writeFile(join(root, "changed.rs"), "fn before() {}\n");
    await sh(root, "add", "-A");
    await sh(root, "commit", "-q", "-m", "first");
    await sh(root, "worktree", "add", "-q", "-b", "agent/x", worktree, "HEAD");
    return { root, historyRoot, worktree };
};

const objectFile = async (dir: string, sha: string): Promise<string> => join(await sh(dir, "rev-parse", "--path-format=absolute", "--git-common-dir"), "objects", sha.slice(0, 2), sha.slice(2));

// What the crash did: the same length, every byte NUL.
const zero = async (path: string): Promise<void> => {
    const { size } = await stat(path);
    await chmod(path, 0o644);
    await writeFile(path, Buffer.alloc(size));
};

const options = { git, deadline: Number.POSITIVE_INFINITY };

test("a loose object is sound only when it inflates to the object its name hashes", async () => {
    const { root } = await workspace();
    const sha = await sh(root, "rev-parse", "HEAD:kept.rs");
    const bytes = await readFile(await objectFile(root, sha));

    expect(looseObjectSound(bytes, sha)).toBe(true);
    expect(looseObjectSound(Buffer.alloc(bytes.length), sha)).toBe(false);
    expect(looseObjectSound(bytes.subarray(0, bytes.length - 4), sha)).toBe(false);
    expect(looseObjectSound(bytes, `${sha.slice(0, -1)}0`)).toBe(sha.endsWith("0"));
});

test("a zeroed blob a checkout still holds is set aside and rebuilt, and git reads the repository whole again", async () => {
    const { root } = await workspace();
    const sha = await sh(root, "rev-parse", "HEAD:kept.rs");
    await zero(await objectFile(root, sha));

    const repair = await repairRepo("root", root, options);

    expect(repair).toMatchObject({ quarantined: [sha], rebuilt: [sha], missing: [], refsLost: [] });
    expect(await sh(root, "cat-file", "-p", sha)).toBe("fn kept() {}");
    await expect(sh(root, "fsck", "--full")).resolves.toBe("");
});

test("a zeroed blob no checkout holds any more stays missing and is said", async () => {
    const { root, worktree } = await workspace();
    const sha = await sh(root, "rev-parse", "HEAD:changed.rs");
    // Both checkouts moved on from that content, so no file on disk hashes to the blob.
    await writeFile(join(root, "changed.rs"), "fn after() {}\n");
    await sh(root, "add", "changed.rs");
    await writeFile(join(worktree, "changed.rs"), "fn elsewhere() {}\n");
    await sh(worktree, "add", "changed.rs");
    await zero(await objectFile(root, sha));

    const repair = await repairRepo("root", root, options);

    expect(repair).toMatchObject({ quarantined: [sha], rebuilt: [], missing: [{ sha, type: "blob" }] });
});

test("a zeroed tree comes back from a checkout's index that still describes it", async () => {
    const { root } = await workspace();
    const tree = await sh(root, "rev-parse", "HEAD^{tree}");
    await zero(await objectFile(root, tree));

    const repair = await repairRepo("root", root, options);

    expect(repair).toMatchObject({ quarantined: [tree], rebuilt: [tree], missing: [] });
    expect(await sh(root, "ls-tree", "--name-only", "HEAD")).toBe("changed.rs\nkept.rs");
});

test("a zeroed ref goes back to where its reflog last had it", async () => {
    const { root } = await workspace();
    const head = await sh(root, "rev-parse", "HEAD");
    const ref = join(await sh(root, "rev-parse", "--path-format=absolute", "--git-common-dir"), "refs", "heads", "agent", "x");
    await zero(ref);

    const repair = await repairRepo("root", root, options);

    expect(repair).toMatchObject({ refsRestored: ["refs/heads/agent/x"], refsLost: [] });
    expect(await sh(root, "rev-parse", "agent/x")).toBe(head);
});

test("a pass files one card row for a repository that lost objects, and a clean pass clears it", async () => {
    const { root, historyRoot, worktree } = await workspace();
    const sha = await sh(root, "rev-parse", "HEAD:changed.rs");
    await writeFile(join(root, "changed.rs"), "fn after() {}\n");
    await sh(root, "add", "changed.rs");
    await writeFile(join(worktree, "changed.rs"), "fn elsewhere() {}\n");
    await sh(worktree, "add", "changed.rs");
    await zero(await objectFile(root, sha));
    const scope = { workspaceRoot: root, historyRoot, logger: quiet, gitFor: () => git };

    await checkGitIntegrity(scope, "test");

    expect(integrityCardPath(historyRoot)).toBe(join(historyRoot, "gits"));
    const [card] = manifestProblems(root, historyRoot);
    expect(card?.path).toBe("/history/gits");
    expect(card?.problems).toHaveLength(1);
    expect(card?.problems[0]).toMatchObject({ kind: "unreadable", reason: "io" });
    expect(card?.problems[0]?.fix).toContain(`git -C ${root} fetch --refetch`);
    expect(card?.problems[0]?.detail).toBe(
        "After the sandbox stopped uncleanly, the workspace's own history (root) lost 1 git object that nothing on this disk could rebuild",
    );

    // Whoever brings the content back by hand (a fetch, a copy found elsewhere) leaves the next pass nothing to say.
    await writeFile(join(historyRoot, "found.rs"), "fn before() {}\n");
    expect(await sh(root, "hash-object", "-w", join(historyRoot, "found.rs"))).toBe(sha);
    await checkGitIntegrity(scope, "test");

    expect(manifestProblems(root, historyRoot)).toEqual([]);
});

// The land on 10-31 06:00 died on the corrupt object with nothing checking the repository; now the sighting starts a pass.
test("a git failing on damaged storage starts one pass, and a clean boot starts none", async () => {
    const { root, historyRoot } = await workspace();
    const sha = await sh(root, "rev-parse", "HEAD:kept.rs");
    await zero(await objectFile(root, sha));
    const scope = { workspaceRoot: root, historyRoot, logger: quiet, gitFor: () => git };

    expect(startGitIntegrity(scope, false)).toBeUndefined();
    reportGitFailure(root, `fatal: loose object ${sha} (stored in ${await objectFile(root, sha)}) is corrupt`);
    await passInFlight();

    expect(await sh(root, "cat-file", "-p", sha)).toBe("fn kept() {}");
});
