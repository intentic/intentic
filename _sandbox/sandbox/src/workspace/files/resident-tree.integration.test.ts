import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { WorkspaceTree } from "@intentic/sandbox-contract";
import { createResidentTree, type ResidentTree } from "./resident-tree.js";
import { walkWorkspaceTree } from "./workspace-tree.js";

// The resident tree must answer exactly what a fresh walk of the same disk answers, first listing and after every
// batch alike, or the explorer drifts from the files. Every comparison here is against the real walk.

let root: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "resident-tree-"));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const write = (rel: string, content = "x"): void => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
};

// What the resident tree answers, less the generation a walk has no notion of, and what a walk of the disk answers.
const held = (resident: ResidentTree): WorkspaceTree => {
    const { generation: _generation, ...tree } = resident.view();
    return tree;
};
const walked = (): Promise<WorkspaceTree> => walkWorkspaceTree(root);

// Every path under `gone`, and `gone` itself, out of a tracked list.
const dropUnder = (list: string[], gone: string): void => {
    const kept = list.filter((path) => path !== gone && !path.startsWith(`${gone}/`));
    list.splice(0, list.length, ...kept);
};

test("lists what the walk lists: ignore layers, junk folders, links, locked paths and barren branches", async () => {
    write("README.md", "hello");
    write("src/app.ts", "export {}");
    write("src/gen/out.js");
    write("src/.gitignore", "gen/\n*.log\n!keep.log\n");
    write("src/debug.log");
    write("src/keep.log");
    write("node_modules/pkg/index.js");
    write(".git/HEAD", "ref: refs/heads/main");
    mkdirSync(join(root, "empty/deeper/still"), { recursive: true });
    symlinkSync(join(root, "src"), join(root, "src-link"));
    symlinkSync("/nowhere/at/all", join(root, "broken-link"));
    symlinkSync(tmpdir(), join(root, "outside-link"));
    const resident = createResidentTree(root);
    await resident.ready;
    expect(held(resident)).toEqual(await walked());
    expect(resident.view().barren).toEqual(["empty", "empty/deeper", "empty/deeper/still"]);
});

test("keeps the walk's budget: a folder that will not fit stays unopened whole", async () => {
    for (const dir of ["alpha", "beta", "gamma"]) {
        for (let index = 0; index < 2100; index += 1) {
            write(`${dir}/f${index}.txt`);
        }
    }
    write("zeta/small.txt");
    const resident = createResidentTree(root);
    await resident.ready;
    expect(held(resident)).toEqual(await walked());
    write("beta/one-more.txt");
    await resident.apply(["beta/one-more.txt"]);
    expect(held(resident)).toEqual(await walked());
});

test("a delta names the folders that changed, counts on from the last generation, and says nothing when nothing did", async () => {
    write("docs/a.md");
    const resident = createResidentTree(root);
    await resident.ready;
    const start = resident.view().generation!;
    write("docs/b.md");
    const delta = await resident.apply(["docs/b.md"]);
    expect(delta).toMatchObject({ from: start, generation: start + 1 });
    expect(delta?.dirs.map((dir) => dir.path)).toEqual(["docs"]);
    expect(delta?.dirs[0]?.entries.map((entry) => entry.name)).toEqual(["a.md", "b.md"]);
    // A path inside a folder nobody opens moves nothing held.
    write("node_modules/pkg/index.js");
    expect(await resident.apply(["node_modules/pkg/index.js"])).toBeUndefined();
    expect(resident.view().generation).toBe(start + 1);
    // A new folder's own listing rides the same delta as the parent that gained it.
    write("docs/guide/intro.md");
    const nested = await resident.apply(["docs/guide", "docs/guide/intro.md"]);
    expect(nested?.dirs.map((dir) => dir.path)).toEqual(["docs", "docs/guide"]);
});

test("a .gitignore that changes re-decides every verdict beneath it", async () => {
    write("app/build/out.js");
    write("app/src/main.ts");
    write("app/notes.log");
    const resident = createResidentTree(root);
    await resident.ready;
    write("app/.gitignore", "build/\n*.log\n");
    const delta = await resident.apply(["app/.gitignore"]);
    expect(held(resident)).toEqual(await walked());
    expect(delta?.dirs.map((dir) => dir.path)).toContain("app");
    rmSync(join(root, "app/.gitignore"));
    await resident.apply(["app/.gitignore"]);
    expect(held(resident)).toEqual(await walked());
});

// Seeded, so a failure replays: every step is one thing a person or an agent does to a tree, reported the way the
// watcher reports it, and after every step the resident answer must be the walk's.
test("stays what the walk lists through a long run of edits", async () => {
    let seed = 20_260_924;
    const next = (bound: number): number => {
        seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
        return seed % bound;
    };
    const pick = <T,>(items: readonly T[]): T => items[next(items.length)]!;
    const names = ["a", "b", "c", "build", "node_modules", "sub", "x.log", "keep.log", "secret.txt", "file.txt"];
    const patterns = ["*.log", "build/", "secret*", "!keep.log", "sub/", "c"];
    const dirs = [""];
    const files: string[] = [];
    const resident = createResidentTree(root);
    await resident.ready;
    for (let step = 0; step < 80; step += 1) {
        const dir = pick(dirs);
        const at = (name: string): string => (dir === "" ? name : `${dir}/${name}`);
        const changed: string[] = [];
        switch (next(7)) {
            case 0: {
                const path = at(pick(names));
                if (!dirs.includes(path)) {
                    write(path, "x".repeat(next(50)));
                    files.push(path);
                    changed.push(path);
                }
                break;
            }
            case 1: {
                const path = at(pick(names));
                if (!files.includes(path) && !dirs.includes(path)) {
                    mkdirSync(join(root, path), { recursive: true });
                    dirs.push(path);
                    changed.push(path);
                }
                break;
            }
            case 2: {
                const path = files.length > 0 ? pick(files) : undefined;
                if (path !== undefined) {
                    rmSync(join(root, path), { force: true });
                    files.splice(files.indexOf(path), 1);
                    changed.push(path);
                }
                break;
            }
            case 3: {
                const gone = dirs.length > 1 ? pick(dirs.filter((candidate) => candidate !== "")) : undefined;
                if (gone !== undefined) {
                    rmSync(join(root, gone), { recursive: true, force: true });
                    dropUnder(dirs, gone);
                    dropUnder(files, gone);
                    changed.push(gone);
                }
                break;
            }
            case 4: {
                const path = at(".gitignore");
                write(path, `${pick(patterns)}\n${pick(patterns)}\n`);
                if (!files.includes(path)) {
                    files.push(path);
                }
                changed.push(path);
                break;
            }
            case 5: {
                const from = files.length > 0 ? pick(files) : undefined;
                const to = at(`moved-${step}`);
                if (from !== undefined) {
                    renameSync(join(root, from), join(root, to));
                    files.splice(files.indexOf(from), 1, to);
                    changed.push(from, to);
                }
                break;
            }
            default: {
                const path = files.length > 0 ? pick(files) : undefined;
                if (path !== undefined) {
                    appendFileSync(join(root, path), "more");
                    changed.push(path);
                }
            }
        }
        if (changed.length > 0) {
            await resident.apply(changed);
        }
        expect(held(resident)).toEqual(await walked());
    }
    // And a batch too large to name lists everything again to the same answer.
    write("late/one.txt");
    await resident.apply([]);
    expect(held(resident)).toEqual(await walked());
});
