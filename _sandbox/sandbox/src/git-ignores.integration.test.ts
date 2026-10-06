import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gitIgnores } from "./git-ignores.js";

// Real git: whether a path is read as a path or as a flag is git's own option parsing, not a string the helper builds.
const repoIgnoring = async (patterns: readonly string[]): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "check-ignore-"));
    await promisify(execFile)("git", ["-C", dir, "init", "-q"]);
    await writeFile(join(dir, ".gitignore"), `${patterns.join("\n")}\n`);
    return dir;
};

test("an ignored path reads ignored and a tracked one does not", async () => {
    const repo = await repoIgnoring(["*.log"]);
    expect(await gitIgnores(repo, "build.log")).toBe(true);
    expect(await gitIgnores(repo, "src/index.ts")).toBe(false);
    expect(await gitIgnores(repo, join(repo, "build.log"))).toBe(true);
});

// Without `--`, git took `-q -v.log` for an unknown switch, exited 129, and the ignored file read as not ignored.
test("a path that starts with a dash is asked about as a path, never read as an option", async () => {
    const repo = await repoIgnoring(["*.log"]);
    expect(await gitIgnores(repo, "-v.log")).toBe(true);
    expect(await gitIgnores(repo, "--stdin.log")).toBe(true);
    expect(await gitIgnores(repo, "-not-ignored.ts")).toBe(false);
});

test("outside any repository nothing reads ignored", async () => {
    const bare = await mkdtemp(join(tmpdir(), "check-ignore-none-"));
    expect(await gitIgnores(bare, "build.log")).toBe(false);
});
