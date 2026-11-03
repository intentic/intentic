import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createLogger } from "../../logger.js";
import { zeroedFiles } from "../../git/integrity/zeroed-files.js";
import { checkpointWorktree, type CheckpointDeps, takeCheckpointNote } from "./checkpoint-worktree.js";

// Real git and a real disk: what a crash leaves is a file's size without its bytes, which only a file on disk can show.

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

const AUTHORITY = "pub fn authority() -> u32 {\n    42\n}\n";

// A conversation's checkout of repo `game`, with three tracked text files and one tracked binary committed.
const checkout = async (): Promise<{ services: CheckpointDeps; dir: string }> => {
    const base = await mkdtemp(join(tmpdir(), "checkpoint-zeroed-"));
    tempDirs.push(base);
    const dir = join(base, "wt", "game");
    const main = join(base, "work");
    await mkdir(dir, { recursive: true });
    await mkdir(main, { recursive: true });
    await sh(dir, "init", "-q", "-b", "main");
    await sh(dir, "config", "user.email", "t@example.com");
    await sh(dir, "config", "user.name", "t");
    await writeFile(join(dir, "authority.rs"), AUTHORITY);
    await writeFile(join(dir, "notes.md"), "notes\n");
    await writeFile(join(dir, "edited.rs"), "fn a() {}\n");
    await writeFile(join(dir, "sprite.bin"), Buffer.from([0, 1, 2, 3]));
    await sh(dir, "add", "-A");
    await sh(dir, "commit", "-q", "-m", "first");
    const services = {
        agentWorktrees: { worktreeDir: () => dir, mainDir: () => main },
        logger,
    } satisfies CheckpointDeps;
    return { services, dir };
};

test("a file zeroed at its own size and one emptied are found; a real edit and a zeroed binary are not", async () => {
    const { dir } = await checkout();
    await writeFile(join(dir, "authority.rs"), Buffer.alloc(AUTHORITY.length));
    await writeFile(join(dir, "notes.md"), "");
    await writeFile(join(dir, "edited.rs"), "fn a() { b() }\n");
    await writeFile(join(dir, "sprite.bin"), Buffer.alloc(4));

    expect(await zeroedFiles(dir, (cwd, args) => exec("git", ["-C", cwd, ...args]))).toEqual([
        { path: "authority.rs", size: AUTHORITY.length, how: "nul" },
        { path: "notes.md", size: 0, how: "emptied" },
    ]);
});

test("NUL bytes at a different size are an edit, not a crash", async () => {
    const { dir } = await checkout();
    await writeFile(join(dir, "authority.rs"), Buffer.alloc(AUTHORITY.length + 1));

    expect(await zeroedFiles(dir, (cwd, args) => exec("git", ["-C", cwd, ...args]))).toEqual([]);
});

// The checkpoint that buried the damage on 10-30 committed `authority.rs | Bin 11664 -> 11664 bytes`.
test("the checkpoint commits the real edit, leaves the zeroed file out with HEAD's content, and tells the conversation", async () => {
    const { services, dir } = await checkout();
    await writeFile(join(dir, "authority.rs"), Buffer.alloc(AUTHORITY.length));
    await writeFile(join(dir, "edited.rs"), "fn a() { b() }\n");

    await checkpointWorktree(services, "conv-zeroed", [{ repo: "game", base: "" }]);

    expect(await sh(dir, "show", "--name-only", "--format=", "HEAD")).toBe("edited.rs");
    expect(await sh(dir, "show", "HEAD:authority.rs")).toBe(AUTHORITY.trimEnd());
    expect(await sh(dir, "status", "--porcelain")).toBe("M authority.rs");
    const note = takeCheckpointNote("conv-zeroed");
    expect(note?.text).toContain(`game: \`authority.rs\` (${String(AUTHORITY.length)} bytes, all NUL)`);
    expect(note?.text).toContain("git checkout HEAD -- <path>");
    expect(takeCheckpointNote("conv-zeroed")).toBeUndefined();
});
