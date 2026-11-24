import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBridgeHeads, parsePackedRefs } from "./bridge-heads.js";

// Real git dirs under a temp /history/gits, laid out as the sandbox keeps them (a checkout whose `.git` was moved there,
// named by its URI-encoded repo id), so what git writes is what the reader parses.

const git = (dir: string, ...args: string[]): string =>
    execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "init.defaultBranch=main", "-C", dir, ...args], {
        encoding: "utf8",
    }).trim();

const history = (): string => {
    const root = mkdtempSync(join(tmpdir(), "bridge-heads-"));
    mkdirSync(join(root, "gits"));
    return root;
};

// A repository with one commit, its git dir at gits/<entry>; answers the checkout and the commit.
const repoAt = (root: string, entry: string) => {
    const checkout = mkdtempSync(join(tmpdir(), "bridge-checkout-"));
    git(checkout, "init", "-q", `--separate-git-dir=${join(root, "gits", entry)}`);
    writeFileSync(join(checkout, "a.txt"), "one\n");
    git(checkout, "add", "a.txt");
    git(checkout, "commit", "-qm", "one");
    return { checkout, tip: git(checkout, "rev-parse", "HEAD") };
};

test("each repository's branch and tip, by its decoded id, the workspace root and non-repositories left out", async () => {
    const root = history();
    const intentic = repoAt(root, "intentic");
    const nested = repoAt(root, encodeURIComponent("extensions/notes"));
    repoAt(root, "root");
    mkdirSync(join(root, "gits", "not-a-repo"));
    expect(await createBridgeHeads(root).list()).toEqual([
        { repo: "extensions/notes", branch: "main", tip: nested.tip },
        { repo: "intentic", branch: "main", tip: intentic.tip },
    ]);
});

test("a commit, a branch switch and packed refs all read as they are, from one reader asked again", async () => {
    const root = history();
    const { checkout, tip } = repoAt(root, "proj");
    const heads = createBridgeHeads(root);
    expect(await heads.list()).toEqual([{ repo: "proj", branch: "main", tip }]);

    writeFileSync(join(checkout, "a.txt"), "two\n");
    git(checkout, "commit", "-qam", "two");
    const second = git(checkout, "rev-parse", "HEAD");
    expect(await heads.list()).toEqual([{ repo: "proj", branch: "main", tip: second }]);

    git(checkout, "checkout", "-q", "-b", "feature", tip);
    expect(await heads.list()).toEqual([{ repo: "proj", branch: "feature", tip }]);

    // Every ref packed and the loose files gone: read out of packed-refs.
    git(checkout, "pack-refs", "--all");
    expect(await heads.list()).toEqual([{ repo: "proj", branch: "feature", tip }]);
    git(checkout, "checkout", "-q", "main");
    expect(await heads.list()).toEqual([{ repo: "proj", branch: "main", tip: second }]);
});

test("a ref replaced within the same mtime tick is still seen moving, by its inode", async () => {
    const root = history();
    const { tip } = repoAt(root, "proj");
    const heads = createBridgeHeads(root);
    expect(await heads.list()).toEqual([{ repo: "proj", branch: "main", tip }]);
    // As git moves a ref: a new file renamed over the old one, same size.
    const ref = join(root, "gits", "proj", "refs", "heads", "main");
    const moved = "f".repeat(tip.length);
    writeFileSync(`${ref}.lock`, `${moved}\n`);
    renameSync(`${ref}.lock`, ref);
    expect(await heads.list()).toEqual([{ repo: "proj", branch: "main", tip: moved }]);
});

test("an unborn branch has no tip, a detached HEAD no branch, and a ref format it cannot read asks for a probe", async () => {
    const root = history();
    const unborn = mkdtempSync(join(tmpdir(), "bridge-checkout-"));
    git(unborn, "init", "-q", `--separate-git-dir=${join(root, "gits", "unborn")}`);
    const { checkout } = repoAt(root, "detached");
    git(checkout, "checkout", "-q", "--detach");
    repoAt(root, "reftable");
    writeFileSync(join(root, "gits", "reftable", "HEAD"), "ref: refs/heads/.invalid\n");
    repoAt(root, "symbolic");
    writeFileSync(join(root, "gits", "symbolic", "refs", "heads", "main"), "ref: refs/heads/other\n");
    expect(await createBridgeHeads(root).list()).toEqual([
        { repo: "detached" },
        { repo: "reftable", probe: true },
        { repo: "symbolic", branch: "main", probe: true },
        { repo: "unborn", branch: "main" },
    ]);
});

test("a sandbox with no gits folder yet advertises no repositories", async () => {
    expect(await createBridgeHeads(mkdtempSync(join(tmpdir(), "bridge-heads-empty-"))).list()).toEqual([]);
});

test("packed-refs: names and shas past the header, peeled tag lines skipped", () => {
    const sha = "1".repeat(40);
    const peeled = "2".repeat(40);
    const text = `# pack-refs with: peeled fully-peeled sorted \n${sha} refs/heads/main\n${sha} refs/tags/v1\n^${peeled}\n`;
    expect([...parsePackedRefs(text)]).toEqual([
        ["refs/heads/main", sha],
        ["refs/tags/v1", sha],
    ]);
});
