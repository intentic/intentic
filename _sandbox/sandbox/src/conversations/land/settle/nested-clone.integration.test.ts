import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { unstubbed } from "@intentic/testing";
import { isolatedAgent } from "../../registry/agents-store.testing.js";
import { type CloneDeps, placeClone, settleClone } from "./nested-clone.js";

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();

// A conversation's copy holding `integra/`, a repository a turn made with `git init`, and the main tree beside it.
const setup = async (commits: number) => {
    const base = await mkdtemp(join(tmpdir(), "nested-clone-"));
    const copy = join(base, "copy");
    const main = join(base, "main");
    await mkdir(join(copy, "integra", "src"), { recursive: true });
    await mkdir(main, { recursive: true });
    const clone = join(copy, "integra");
    await sh(clone, "init", "-q", "-b", "main");
    await writeFile(join(clone, ".gitignore"), "/target\n");
    await writeFile(join(clone, "src", "lib.rs"), "pub fn x() {}\n");
    await mkdir(join(clone, "target"), { recursive: true });
    await writeFile(join(clone, "target", "big.o"), "build output\n");
    for (let index = 0; index < commits; index++) {
        await writeFile(join(clone, `step${index}.txt`), `${index}\n`);
        await sh(clone, "add", "-A");
        await sh(clone, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", `step ${index}`);
    }
    const forgotten: string[] = [];
    const deps = unstubbed<CloneDeps>("deps", {
        conversations: unstubbed<CloneDeps["conversations"]>("conversations", {
            running: () => false,
            landing: () => false,
            withLandLease: async <T>(_id: string, task: () => Promise<T>): Promise<T> => task(),
        }),
        agentWorktrees: unstubbed<CloneDeps["agentWorktrees"]>("agentWorktrees", {
            attached: async () => true,
            worktreeDir: () => copy,
            mainDir: () => main,
        }),
        agents: unstubbed<CloneDeps["agents"]>("agents", {
            forgetStranded: async (_id: string, dir: string) => void forgotten.push(dir),
            // The books settle off the registry's entry; none here, so they settle nothing.
            entry: () => undefined,
        }),
    });
    const entry = isolatedAgent([{ repo: "root", base: "a".repeat(40) }]);
    return { copy, main, clone, deps, entry, forgotten };
};

test("a clone `git init` made and nothing committed in folds into its repository: its .git goes, its files stay", async () => {
    const { clone, deps, entry, forgotten } = await setup(0);
    await settleClone(deps, entry, { id: "c1", dir: "integra", action: "fold" });
    expect(existsSync(join(clone, ".git"))).toBe(false);
    expect(await readFile(join(clone, "src", "lib.rs"), "utf8")).toBe("pub fn x() {}\n");
    expect(forgotten).toEqual(["integra"]);
});

test("a clone holding commits folds only when the caller names their count", async () => {
    const { clone, deps, entry } = await setup(2);
    await expect(settleClone(deps, entry, { id: "c1", dir: "integra", action: "fold" })).rejects.toThrow("integra holds 2 commits");
    await expect(settleClone(deps, entry, { id: "c1", dir: "integra", action: "fold", dropCommits: 1 })).rejects.toThrow("holds 2 commits");
    expect(existsSync(join(clone, ".git"))).toBe(true);
    await settleClone(deps, entry, { id: "c1", dir: "integra", action: "fold", dropCommits: 2 });
    expect(existsSync(join(clone, ".git"))).toBe(false);
});

test("adopting moves the clone into the workspace with its history and every file git keeps, and out of the copy", async () => {
    const { clone, main, deps, entry, forgotten } = await setup(1);
    await writeFile(join(clone, "notes.md"), "uncommitted\n");
    await settleClone(deps, entry, { id: "c1", dir: "integra", action: "adopt" });
    const moved = join(main, "integra");
    expect(await sh(moved, "log", "--format=%s")).toBe("step 0");
    expect(await readFile(join(moved, "notes.md"), "utf8")).toBe("uncommitted\n");
    expect(await readFile(join(moved, "src", "lib.rs"), "utf8")).toBe("pub fn x() {}\n");
    // Build output an ignore rule names stays behind with the copy, which a land leaves it to as well.
    expect(existsSync(join(moved, "target"))).toBe(false);
    expect(existsSync(clone)).toBe(false);
    expect(forgotten).toEqual(["integra"]);
});

test("adopting refuses a folder the workspace already has, and moves nothing", async () => {
    const { clone, main, deps, entry } = await setup(0);
    await mkdir(join(main, "integra"));
    await expect(settleClone(deps, entry, { id: "c1", dir: "integra", action: "adopt" })).rejects.toThrow("your workspace already has integra");
    expect(existsSync(join(clone, ".git"))).toBe(true);
});

test("a folder that leaves the copy, or names a composed repository itself, is no clone to settle", () => {
    const entry = isolatedAgent([
        { repo: "root", base: "a".repeat(40) },
        { repo: "api", base: "b".repeat(40) },
    ]);
    const dirOf = (repo: string): string => `/copies/c1/${repo}`;
    expect(placeClone(entry, "api/vendor/lib", dirOf)).toEqual({ parent: "api", dir: "api/vendor/lib", path: "/copies/c1/api/vendor/lib" });
    expect(placeClone(entry, "integra/", dirOf)).toEqual({ parent: "root", dir: "integra", path: "/copies/c1/root/integra" });
    expect(() => placeClone(entry, "../outside", dirOf)).toThrow("not a folder inside");
    expect(() => placeClone(entry, "integra/../..", dirOf)).toThrow("not a folder inside");
});
