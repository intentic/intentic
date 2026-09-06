import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { expect, test } from "vitest";
import { scanBarrenDirs } from "./empty-dirs.js";
import { walkWorkspaceTree } from "./workspace-tree.js";

const workspace = (): Promise<string> => mkdtemp(join(tmpdir(), "ws-barren-"));

test("scanBarrenDirs reports an empty folder and every folder above it that holds nothing else", async () => {
    const root = await workspace();
    await mkdir(join(root, "web", "demo", "assets"), { recursive: true });
    await writeFile(join(root, "README.md"), "#");

    expect(await scanBarrenDirs(root)).toEqual(["web", "web/demo", "web/demo/assets"]);
});

test("scanBarrenDirs finds a barren pocket under a folder full of files, at any depth", async () => {
    const root = await workspace();
    // Six levels down, well past anything a listing budget would reach: this is the case the sweep was blind to,
    // an empty folder left inside a repository by a move.
    await mkdir(join(root, "repo", "src", "composables", "workspace", "old"), { recursive: true });
    await mkdir(join(root, "repo", "src", "host"), { recursive: true });
    await writeFile(join(root, "repo", "package.json"), "{}");
    await writeFile(join(root, "repo", "src", "composables", "workspace", "tree.ts"), "export {};");

    expect(await scanBarrenDirs(root)).toEqual(["repo/src/composables/workspace/old", "repo/src/host"]);
});

test("scanBarrenDirs counts a file as content however small, and however deep", async () => {
    const root = await workspace();
    await mkdir(join(root, "a", "b", "c"), { recursive: true });
    await writeFile(join(root, "a", "b", "c", ".gitkeep"), "");

    expect(await scanBarrenDirs(root)).toEqual([]);
});

test("scanBarrenDirs leaves ignored territory alone, and never offers the folder holding it", async () => {
    const root = await workspace();
    // An empty dir inside node_modules is the package manager's business, and `a` holds one, so it is not a
    // folder anybody should be invited to sweep either.
    await mkdir(join(root, "a", "node_modules", "dep", "empty"), { recursive: true });
    await mkdir(join(root, "b", "out"), { recursive: true });
    await writeFile(join(root, "b", ".gitignore"), "out/\n");

    expect(await scanBarrenDirs(root)).toEqual([]);
});

test("scanBarrenDirs never descends the daemon's locked folders, nor counts one as emptiness above it", async () => {
    const root = await workspace();
    await mkdir(join(root, STATE_DIR, "secrets", "auth"), { recursive: true });

    // `.intentic/secrets/auth` is locked: unlistable here, so unknown, so neither it nor `.intentic/secrets`
    // above it can be claimed empty.
    expect(await scanBarrenDirs(root)).toEqual([]);
});

test("scanBarrenDirs treats a symlink as content: deleting one removes the link, not what it points at", async () => {
    const root = await workspace();
    await mkdir(join(root, "skills"), { recursive: true });
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "app.ts"), "export {};");
    await symlink(join(root, "src"), join(root, "skills", "linked"), "dir");

    expect(await scanBarrenDirs(root)).toEqual([]);
});

test("scanBarrenDirs stops at its cap rather than half-answering: an unfinished folder is unknown, never empty", async () => {
    const root = await workspace();
    await mkdir(join(root, "a", "b", "c"), { recursive: true });

    // One directory's worth of budget: the root is visited, `a` is not, so nothing is known to be empty.
    expect(await scanBarrenDirs(root, { maxDirs: 1 })).toEqual([]);
});

test("walkWorkspaceTree reports empty folders its own entry budget never reached", async () => {
    const root = await workspace();
    await mkdir(join(root, "repo", "src", "deep"), { recursive: true });
    await mkdir(join(root, "repo", "src", "gone"), { recursive: true });
    for (const name of ["one", "two", "three", "four"]) {
        await writeFile(join(root, "repo", `${name}.ts`), "export {};");
    }

    // A budget too small to list past the top level: none of `repo/src` is anywhere in the tree, and the sweep
    // is told about all of it anyway, which is the whole point of asking the question separately. `repo/src`
    // heads the branch, since the four files sit in `repo` itself.
    const result = await walkWorkspaceTree(root, { maxEntries: 1 });
    expect(result.tree.map((entry) => entry.path)).toEqual(["repo"]);
    expect(result.tree[0]?.children).toBeUndefined();
    expect(result.barren).toEqual(["repo/src", "repo/src/deep", "repo/src/gone"]);
});
