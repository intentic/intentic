import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { changedFiles } from "./changes.js";
import { conflictedSides, stagedSides, unstagedSides, withCodeCounts } from "./code-counts.js";

/* AGAINST A REAL REPO AND THE REAL GRAMMARS, because both halves of this are things only the real thing can
 * answer: which blob git hands back for a spec, and which of a file's lines TextMate calls a comment. A test
 * with a fake git and a hand-rolled comment rule would pin neither.
 *
 * What is being pinned is the pairing as much as the arithmetic: each row's code-only count has to describe the
 * SAME comparison the diff it opens does, so the staged row counts index-vs-HEAD while the unstaged row beside
 * it counts worktree-vs-index, on the same path, in the same scan. */

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

// One commit holding a two-line TypeScript file, the shape every case below edits.
const tempRepo = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "intentic-code-counts-"));
    tempDirs.push(dir);
    await sh(dir, "init", "-q");
    await writeFile(join(dir, "a.ts"), `${["const a = 1;", "const b = 2;"].join("\n")}\n`);
    await sh(dir, "add", "-A");
    await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
    return dir;
};

const counted = async (dir: string) => {
    const { head, staged, unstaged, conflicted, blobs } = await changedFiles(dir);
    return {
        staged: await withCodeCounts(dir, staged, stagedSides(head, blobs)),
        unstaged: await withCodeCounts(dir, unstaged, unstagedSides(dir, blobs)),
        conflicted: await withCodeCounts(dir, conflicted, conflictedSides(dir, head)),
    };
};

test("counts an edit as the code it added, leaving the comments to git's own numbers", async () => {
    const dir = await tempRepo();
    await writeFile(
        join(dir, "a.ts"),
        `${["// why this exists", "// and what it does", "const a = 1;", "const b = 2;", "const c = 3;"].join("\n")}\n`,
    );

    const { unstaged } = await counted(dir);

    // Git sees three added lines; two of them are comment, so the reading a review shows is one.
    expect(unstaged).toEqual([{ path: "a.ts", status: "modified", additions: 3, deletions: 0, code: { additions: 1, deletions: 0 } }]);
});

test("a change that is ALL comment counts as no code at all, which is what the badge says out loud", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "a.ts"), `${["// a note", "const a = 1;", "const b = 2;"].join("\n")}\n`);

    const { unstaged } = await counted(dir);

    expect(unstaged[0]?.code).toEqual({ additions: 0, deletions: 0 });
    expect(unstaged[0]?.additions).toBe(1);
});

/* THE TWO SIDES OF ONE PATH ARE TWO DIFFERENT COMPARISONS, and each row's count has to describe its own: the
 * staged row is index-vs-HEAD, the unstaged row worktree-vs-index. A single count per path would put the same
 * pair of numbers on two rows whose diffs show different changes. */
test("gives a partially staged file a count per side", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "a.ts"), `${["const a = 1;", "const b = 2;", "const c = 3;"].join("\n")}\n`);
    await sh(dir, "add", "a.ts");
    await writeFile(join(dir, "a.ts"), `${["// only a comment now", "const a = 1;", "const b = 2;", "const c = 3;"].join("\n")}\n`);

    const { staged, unstaged } = await counted(dir);

    expect(staged[0]?.code).toEqual({ additions: 1, deletions: 0 });
    expect(unstaged[0]?.code).toEqual({ additions: 0, deletions: 0 });
});

test("reads a new file as the code it is, and a deleted one as the code it took away", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "b.ts"), `${["// a header", "const b = 1;"].join("\n")}\n`);
    await rm(join(dir, "a.ts"));

    const { unstaged } = await counted(dir);
    const row = (path: string) => unstaged.find((change) => change.path === path);

    expect(row("b.ts")?.code).toEqual({ additions: 1, deletions: 0 });
    expect(row("a.ts")?.code).toEqual({ additions: 0, deletions: 2 });
});

// A file this build ships no grammar for has no code-only reading, and that is an answer: the row carries git's
// numbers alone and the panel shows those, exactly as it does for bytes.
test("leaves a file it cannot read as code carrying git's numbers alone", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "notes.unknownext"), "one\ntwo\n");

    const { unstaged } = await counted(dir);

    expect(unstaged.find((change) => change.path === "notes.unknownext")).toEqual({
        path: "notes.unknownext",
        status: "added",
        additions: 2,
        deletions: 0,
    });
});
