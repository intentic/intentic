import type { WorkspaceTreeEntry } from "@intentic/sandbox-contract/schemas/workspace/workspace-tree";
import { indexEntries } from "../../../features/workspace/explorer/tree/treeRows";
import { storeIndex, walkIndex } from "./treeIndex";

const file = (path: string): WorkspaceTreeEntry => ({ path, name: path.split(`/`).at(-1) ?? path, type: `file` });
const dir = (path: string, children?: WorkspaceTreeEntry[]): WorkspaceTreeEntry => ({
    path,
    name: path.split(`/`).at(-1) ?? path,
    type: `dir`,
    children,
});

const tree = [dir(`src`, [dir(`src/api`, [file(`src/api/routes.ts`)]), dir(`src/lib`), file(`src/main.ts`)]), dir(`node_modules`), file(`README.md`)];
const lazy = new Map([
    [`src/lib`, [file(`src/lib/a.ts`), dir(`src/lib/deep`)]],
    [`src/lib/deep`, [file(`src/lib/deep/b.ts`)]],
    [`node_modules`, [dir(`node_modules/vue`)]],
    // A listing kept for a folder the eager walk no longer holds still answers in the store's index.
    [`gone`, [file(`gone/c.ts`)]],
]);
const asked = [
    ``,
    `src`,
    `src/api/routes.ts`,
    `src/lib/a.ts`,
    `src/lib/deep/b.ts`,
    `node_modules/vue`,
    `gone/c.ts`,
    `README.md`,
    `src/nope.ts`,
    `nope/x`,
];

// The whole walk each delta used to make, kept as the reference: the store laid every lazy listing over the eager walk.
const spanned = (): Map<string, WorkspaceTreeEntry> => {
    const map = indexEntries(tree, (entry) => entry.children ?? []);
    for (const listing of lazy.values()) {
        for (const child of listing) {
            map.set(child.path, child);
        }
    }
    return map;
};

// 2026-11-21: every delta walked the whole tree and every lazy listing into a fresh map, twice. The index now finds a
// path folder by folder, and must answer exactly what the whole map did.
it(`answers every path as the store's whole map did, and walks in its order`, () => {
    const index = storeIndex(tree, lazy);
    const whole = spanned();
    expect(asked.map((path) => [index.get(path), index.has(path)])).toEqual(asked.map((path) => [whole.get(path), whole.has(path)]));
    expect([...index.keys()]).toEqual([...whole.keys()]);
    expect(index.size).toBe(whole.size);
});

it(`answers every path as the explorer's walk did, reaching a lazy listing only through the folder that holds it`, () => {
    const index = walkIndex(tree, lazy);
    const whole = indexEntries(tree, (entry) => entry.children ?? lazy.get(entry.path) ?? []);
    expect(asked.map((path) => index.get(path))).toEqual(asked.map((path) => whole.get(path)));
    expect([...index.values()]).toEqual([...whole.values()]);
    expect(index.has(`gone/c.ts`)).toBe(false);
});

it(`finds the entries of a tree that is one folder's contents, whose paths start below the root`, () => {
    const scoped = [dir(`work/app`, [file(`work/app/index.ts`)]), file(`work/notes.md`)];
    const index = walkIndex(scoped, new Map());
    expect([index.get(`work/app/index.ts`)?.path, index.get(`work/notes.md`)?.path, index.get(`work`)]).toEqual([
        `work/app/index.ts`,
        `work/notes.md`,
        undefined,
    ]);
});

it(`keeps answering for the listings it was made with after the live map moves on`, () => {
    const live = new Map(lazy);
    const index = storeIndex(tree, live);
    live.set(`src/lib`, [file(`src/lib/z.ts`)]);
    expect({ a: index.has(`src/lib/a.ts`), z: index.has(`src/lib/z.ts`) }).toEqual({ a: true, z: false });
    expect(storeIndex(tree, live).has(`src/lib/z.ts`)).toBe(true);
});
