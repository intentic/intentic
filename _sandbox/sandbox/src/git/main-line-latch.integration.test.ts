import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { observeGitCommands } from "@intentic/base/git";
import { latchedMainBranch } from "./main-line-lock.js";

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
const tempDirs: string[] = [];
afterEach(async () => {
    observeGitCommands(() => undefined);
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

const repo = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "intentic-main-latch-"));
    tempDirs.push(dir);
    await sh(dir, "init", "-q", "-b", "main");
    await writeFile(join(dir, "a.txt"), "a\n");
    await sh(dir, "add", "-A");
    await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "baseline");
    return dir;
};

test("the latched main line is read from git once per config file, and again after a hand edit", async () => {
    const dir = await repo();
    // The first ask latches `main` into config, which changes the file: the second reads it back once.
    expect(await latchedMainBranch(dir)).toBe("main");
    expect(await latchedMainBranch(dir)).toBe("main");

    const reads: string[] = [];
    observeGitCommands(({ dir: at, args }) => {
        if (at === dir) {
            reads.push(args.join(" "));
        }
    });
    expect(await latchedMainBranch(dir)).toBe("main");
    expect(reads).toEqual([]);

    await sh(dir, "config", "intentic.mainBranch", "trunk");
    expect(await latchedMainBranch(dir)).toBe("trunk");
    expect(reads.some((read) => read.startsWith("config"))).toBe(true);
});
