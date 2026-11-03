import { execFile } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { repairExecutableBits } from "./exec-bit-repair.js";

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();

const seeded = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "exec-bit-repair-"));
    await sh(dir, "init", "-q");
    await writeFile(join(dir, "build.sh"), "#!/bin/sh\necho build\n");
    await writeFile(join(dir, "notes.txt"), "plain\n");
    await writeFile(join(dir, "data.bin"), "no shebang\n");
    await sh(dir, "-c", "core.fileMode=false", "add", "-A");
    await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "seed");
    return dir;
};

const staged = async (dir: string, path: string): Promise<string> => (await sh(dir, "ls-files", "-s", "--", path)).split(" ")[0]!;

// A script committed 100644 under core.fileMode=false stays that way in every checkout cut from it, whatever its disk
// mode in the main tree: nothing stages a file nobody edits.
test("records +x once for a script executable on disk but stored 100644, as a staged change, and leaves the rest", async () => {
    const dir = await seeded();
    await chmod(join(dir, "build.sh"), 0o755);
    // A sync that left a non-script executable is not a script's bit.
    await chmod(join(dir, "data.bin"), 0o755);

    expect(await repairExecutableBits(dir)).toEqual(["build.sh"]);

    expect(await staged(dir, "build.sh")).toBe("100755");
    expect(await staged(dir, "data.bin")).toBe("100644");
    expect(await staged(dir, "notes.txt")).toBe("100644");
    // Uncommitted: the owner sees it in Changes and commits it with the rest.
    expect(await sh(dir, "-c", "core.fileMode=false", "status", "--porcelain")).toBe("M  build.sh");
    expect(await sh(dir, "ls-tree", "HEAD", "--", "build.sh")).toMatch(/^100644 /);

    // Once per repository: an owner who unstages it is not overruled at the next boot.
    await sh(dir, "reset", "-q", "--", "build.sh");
    expect(await repairExecutableBits(dir)).toEqual([]);
    expect(await staged(dir, "build.sh")).toBe("100644");
});

test("a repository with nothing to repair is marked done all the same", async () => {
    const dir = await seeded();
    expect(await repairExecutableBits(dir)).toEqual([]);
    await chmod(join(dir, "build.sh"), 0o755);
    expect(await repairExecutableBits(dir)).toEqual([]);
});
