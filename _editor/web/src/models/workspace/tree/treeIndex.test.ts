import type { WorkspaceTreeEntry } from "@intentic/sandbox-contract/schemas/workspace/workspace-tree";
import { eagerIndex, spanningIndex } from "./treeIndex";

const file = (path: string): WorkspaceTreeEntry => ({ path, name: path.split(`/`).at(-1) ?? path, type: `file` });
const dir = (path: string, children?: WorkspaceTreeEntry[]): WorkspaceTreeEntry => ({ path, name: path.split(`/`).at(-1) ?? path, type: `dir`, children });

// Every surface that calls useWorkspaceTree() reads the same snapshot: they share one index of it rather than each
// walking the whole tree again on every delta.
it(`indexes one snapshot once, however many callers ask`, () => {
    const tree = [dir(`src`, [file(`src/a.ts`)]), file(`README.md`)];

    const first = eagerIndex(tree);

    expect(eagerIndex(tree)).toBe(first);
    expect([...first.keys()]).toEqual([`src`, `src/a.ts`, `README.md`]);
    expect(eagerIndex([...tree])).not.toBe(first);
});

it(`lays lazy listings over the snapshot, and gives back the same map until one is read again`, () => {
    const eager = eagerIndex([dir(`src`), dir(`docs`)]);
    expect(spanningIndex(eager, new Map())).toBe(eager);

    const listing = [file(`src/b.ts`)];
    const spanning = spanningIndex(eager, new Map([[`src`, listing]]));
    expect(spanning.get(`src/b.ts`)?.path).toBe(`src/b.ts`);
    expect(spanning.has(`src`)).toBe(true);
    expect(spanningIndex(eager, new Map([[`src`, listing]]))).toBe(spanning);

    const relisted = spanningIndex(eager, new Map([[`src`, [file(`src/c.ts`)]]]));
    expect(relisted).not.toBe(spanning);
    expect({ b: relisted.has(`src/b.ts`), c: relisted.has(`src/c.ts`) }).toEqual({ b: false, c: true });
    // The snapshot's own index is never written into.
    expect(eager.has(`src/c.ts`)).toBe(false);
});
