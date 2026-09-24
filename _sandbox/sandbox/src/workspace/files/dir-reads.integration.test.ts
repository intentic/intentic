import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceTreeEntry } from "@intentic/sandbox-contract";
import { heldDirReads } from "./dir-reads.js";
import { walkWorkspaceTree } from "./workspace-tree.js";

/* Reads held between walks against real folders: the walk answers from what it read until the watcher names a change. */

const roots: string[] = [];
afterAll(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const workspace = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "dir-reads-"));
    roots.push(root);
    await mkdir(join(root, "app", "src"), { recursive: true });
    await writeFile(join(root, "app", "src", "a.ts"), "a");
    return root;
};

const paths = (entries: readonly WorkspaceTreeEntry[]): string[] =>
    entries.flatMap((entry) => [entry.path, ...(entry.children ? paths(entry.children) : [])]);

const sizeOf = (entries: readonly WorkspaceTreeEntry[], path: string): number | undefined => {
    for (const entry of entries) {
        if (entry.path === path) {
            return entry.size;
        }
        const nested = entry.children === undefined ? undefined : sizeOf(entry.children, path);
        if (nested !== undefined) {
            return nested;
        }
    }
    return undefined;
};

test(`a walk answers from held reads until the watcher names a path in that folder`, async () => {
    const root = await workspace();
    const reads = heldDirReads(root);
    expect(paths((await walkWorkspaceTree(root, { reads })).tree)).toContain(`app/src/a.ts`);

    await writeFile(join(root, "app", "src", "b.ts"), "b");
    expect(paths((await walkWorkspaceTree(root, { reads })).tree)).not.toContain(`app/src/b.ts`);

    reads.changed([`app/src/b.ts`]);
    expect(paths((await walkWorkspaceTree(root, { reads })).tree)).toContain(`app/src/b.ts`);
});

test(`a changed file's new size shows once its path is named, and a new folder once its own path is`, async () => {
    const root = await workspace();
    const reads = heldDirReads(root);
    await walkWorkspaceTree(root, { reads });

    await writeFile(join(root, "app", "src", "a.ts"), "aaaa");
    await mkdir(join(root, "app", "lib"));
    await writeFile(join(root, "app", "lib", "c.ts"), "c");
    reads.changed([`app/src/a.ts`, `app/lib`, `app/lib/c.ts`]);

    const tree = (await walkWorkspaceTree(root, { reads })).tree;
    expect(sizeOf(tree, `app/src/a.ts`)).toBe(4);
    expect(paths(tree)).toContain(`app/lib/c.ts`);
});

test(`an unnamed change drops everything held, and nothing is held past its time`, async () => {
    const root = await workspace();
    let now = 1_000;
    const reads = heldDirReads(root, () => now);
    await walkWorkspaceTree(root, { reads });

    await writeFile(join(root, "app", "src", "b.ts"), "b");
    reads.changed([]);
    expect(paths((await walkWorkspaceTree(root, { reads })).tree)).toContain(`app/src/b.ts`);

    await writeFile(join(root, "app", "src", "c.ts"), "c");
    now += 10_001;
    expect(paths((await walkWorkspaceTree(root, { reads })).tree)).toContain(`app/src/c.ts`);
});

test(`the empty-folder answer follows the same reads: a folder that gains a file stops being barren once named`, async () => {
    const root = await workspace();
    await mkdir(join(root, "debris"));
    const reads = heldDirReads(root);
    expect((await walkWorkspaceTree(root, { reads })).barren).toEqual([`debris`]);

    await writeFile(join(root, "debris", "kept.ts"), "k");
    reads.changed([`debris/kept.ts`]);
    expect((await walkWorkspaceTree(root, { reads })).barren).toEqual([]);
});

test(`a .gitignore is honoured when it arrives, through the folder that holds it`, async () => {
    const root = await workspace();
    const reads = heldDirReads(root);
    await walkWorkspaceTree(root, { reads });

    await writeFile(join(root, "app", ".gitignore"), "src/\n");
    reads.changed([`app/.gitignore`]);
    const app = (await walkWorkspaceTree(root, { reads })).tree.find((entry) => entry.name === `app`);
    expect(app?.children?.find((entry) => entry.name === `src`)).toMatchObject({ ignored: true });
});
