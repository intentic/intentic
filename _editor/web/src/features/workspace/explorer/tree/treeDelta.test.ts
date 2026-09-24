import { WORKSPACE_ROOT } from "@intentic/constants";
import type { WorkspaceTree, WorkspaceTreeEntry } from "@intentic/sandbox-contract";
import { patchedTree } from "./treeDelta";

// The daemon keeps the shared tree resident and sends what each batch moved; a tab patches the tree it holds, and one
// holding another generation fetches it afresh rather than patching the wrong tree.

const file = (path: string, size = 1): WorkspaceTreeEntry => ({ name: path.slice(path.lastIndexOf(`/`) + 1), path, type: `file`, size });
const dir = (path: string, children?: WorkspaceTreeEntry[]): WorkspaceTreeEntry => ({
    name: path.slice(path.lastIndexOf(`/`) + 1),
    path,
    type: `dir`,
    ...(children === undefined ? {} : { children }),
});

const TREE: WorkspaceTree = {
    root: WORKSPACE_ROOT,
    tree: [dir(`docs`, [file(`docs/a.md`), dir(`docs/guide`, [file(`docs/guide/intro.md`)])]), dir(`node_modules`), file(`README.md`)],
    hidden: 0,
    barren: [],
    generation: 4,
};

test(`a folder's new entries replace its old ones, and a folder kept among them keeps what it held`, () => {
    const patched = patchedTree(TREE, {
        from: 4,
        generation: 5,
        dirs: [{ path: `docs`, entries: [file(`docs/a.md`, 9), file(`docs/b.md`), dir(`docs/guide`)] }],
    });
    expect(patched?.generation).toBe(5);
    expect(patched?.tree[0]?.children).toEqual([file(`docs/a.md`, 9), file(`docs/b.md`), dir(`docs/guide`, [file(`docs/guide/intro.md`)])]);
    // Everything the delta did not name is the very same object, so nothing else redraws.
    expect(patched?.tree[1]).toBe(TREE.tree[1]);
});

test(`a new folder is filled by its own item, and the root and the barren list move like any folder`, () => {
    const patched = patchedTree(TREE, {
        from: 4,
        generation: 5,
        dirs: [
            { path: ``, entries: [dir(`docs`), dir(`empty`), dir(`node_modules`), file(`README.md`)] },
            { path: `empty`, entries: [] },
        ],
        barren: [`empty`],
    });
    expect(patched?.tree.map((entry) => entry.path)).toEqual([`docs`, `empty`, `node_modules`, `README.md`]);
    expect(patched?.tree[1]?.children).toEqual([]);
    expect(patched?.tree[0]?.children).toHaveLength(2);
    expect(patched?.barren).toEqual([`empty`]);
});

test(`a delta for another generation is refused, so the tab fetches the tree afresh`, () => {
    expect(patchedTree(TREE, { from: 3, generation: 4, dirs: [] })).toBeUndefined();
    expect(patchedTree({ ...TREE, generation: undefined }, { from: 4, generation: 5, dirs: [] })).toBeUndefined();
});

test(`a folder the tab never opened, or that is gone from its tree, is left alone`, () => {
    const patched = patchedTree(TREE, { from: 4, generation: 5, dirs: [{ path: `elsewhere/deep`, entries: [file(`elsewhere/deep/x`)] }] });
    expect(patched?.tree).toEqual(TREE.tree);
});
