import type { WorkspaceTreeEntry } from "@intentic-app/api-contract";
import { describe, expect, it } from "vitest";
import { barrenChainOf, barrenDirs, barrenRoots, branchDirPaths, settleBarren } from "./emptyDirs";

const file = (path: string): WorkspaceTreeEntry => ({ name: path.split(`/`).pop() ?? path, path, type: `file` });
const dir = (path: string, children?: readonly WorkspaceTreeEntry[], ignored?: boolean): WorkspaceTreeEntry => ({
    name: path.split(`/`).pop() ?? path,
    path,
    type: `dir`,
    ...(ignored ? { ignored: true } : {}),
    ...(children !== undefined ? { children } : {}),
});

const NO_LAZY = new Map<string, readonly WorkspaceTreeEntry[]>();

describe(`barrenDirs`, () => {
    it(`marks an empty dir and the whole chain above it`, () => {
        const tree = [dir(`web`, [dir(`web/demo`, [dir(`web/demo/assets`, [])])]), file(`README.md`)];
        expect(barrenDirs(tree, NO_LAZY)).toEqual(new Set([`web`, `web/demo`, `web/demo/assets`]));
    });

    it(`never marks a dir holding a file, however deep`, () => {
        const tree = [dir(`a`, [dir(`a/b`, [file(`a/b/keep.txt`)])])];
        expect(barrenDirs(tree, NO_LAZY)).toEqual(new Set());
    });

    it(`treats unknown (never-listed) dirs as poison, not as empty`, () => {
        // No `children` at all — ignored or beyond the walk's budget. Neither it nor its parent may be flagged.
        const tree = [dir(`a`, [dir(`a/unknown`)])];
        expect(barrenDirs(tree, NO_LAZY)).toEqual(new Set());
    });

    it(`skips ignored dirs and what they sit in`, () => {
        const tree = [dir(`a`, [dir(`a/node_modules`, [], true)])];
        expect(barrenDirs(tree, NO_LAZY)).toEqual(new Set());
    });

    it(`still finds a barren pocket under a non-barren parent`, () => {
        const tree = [dir(`src`, [file(`src/app.ts`), dir(`src/old`, [])])];
        expect(barrenDirs(tree, NO_LAZY)).toEqual(new Set([`src/old`]));
    });

    it(`reads lazily-fetched children when the entry carries none`, () => {
        const lazy = new Map([[`a`, [dir(`a/b`, [])]]]);
        expect(barrenDirs([dir(`a`)], lazy)).toEqual(new Set([`a`, `a/b`]));
    });

    it(`leaves the reference shelf and the outbox alone, empty or not`, () => {
        const tree = [dir(`refs`, []), dir(`public`, [dir(`public/x`, [])])];
        expect(barrenDirs(tree, NO_LAZY)).toEqual(new Set());
    });
});

describe(`barrenRoots`, () => {
    it(`returns the top of each branch, once, in tree order`, () => {
        const tree = [
            dir(`a`, [dir(`a/b`, [])]),
            dir(`src`, [file(`src/app.ts`), dir(`src/old`, [])]),
        ];
        const barren = barrenDirs(tree, NO_LAZY);
        expect(barrenRoots(tree, NO_LAZY, barren).map((entry) => entry.path)).toEqual([`a`, `src/old`]);
    });

    it(`descends non-barren dirs through their lazy children`, () => {
        const lazy = new Map([[`a`, [file(`a/keep.txt`), dir(`a/empty`, [])]]]);
        const tree = [dir(`a`)];
        const barren = barrenDirs(tree, lazy);
        expect(barrenRoots(tree, lazy, barren).map((entry) => entry.path)).toEqual([`a/empty`]);
    });
});

describe(`barrenChainOf`, () => {
    const assets = dir(`public2/demo/assets`, []);
    const demo = dir(`public2/demo`, [assets]);
    const root = dir(`public2`, [demo]);

    it(`follows the single-child descent to the leaf`, () => {
        const barren = barrenDirs([root], NO_LAZY);
        const chain = barrenChainOf(root, NO_LAZY, barren);
        expect(chain.names).toEqual([`public2`, `demo`, `assets`]);
        expect(chain.tail.path).toBe(`public2/demo/assets`);
    });

    it(`stops where the branch widens`, () => {
        const wide = dir(`a`, [dir(`a/b`, [dir(`a/b/c`, []), dir(`a/b/d`, [])])]);
        const barren = barrenDirs([wide], NO_LAZY);
        const chain = barrenChainOf(wide, NO_LAZY, barren);
        expect(chain.names).toEqual([`a`, `b`]);
        expect(chain.tail.path).toBe(`a/b`);
    });

    it(`is a one-link chain for a plain empty dir`, () => {
        const lone = dir(`old`, []);
        const chain = barrenChainOf(lone, NO_LAZY, new Set([`old`]));
        expect(chain.names).toEqual([`old`]);
        expect(chain.tail).toBe(lone);
    });

    it(`stops at a child the given set does not hold (not yet settled)`, () => {
        const barren = barrenDirs([root], NO_LAZY);
        const settled = new Set([...barren].filter((path) => path !== `public2/demo/assets`));
        expect(barrenChainOf(root, NO_LAZY, settled).names).toEqual([`public2`, `demo`]);
    });
});

describe(`branchDirPaths`, () => {
    it(`lists every dir of the branch, root first`, () => {
        const tree = dir(`a`, [dir(`a/b`, [dir(`a/b/c`, []), dir(`a/b/d`, [])])]);
        expect(branchDirPaths(tree, NO_LAZY)).toEqual([`a`, `a/b`, `a/b/c`, `a/b/d`]);
    });
});

describe(`settleBarren`, () => {
    const none = new Set<string>();

    it(`stamps a new path and settles it only after the window`, () => {
        const first = settleBarren(new Set([`a`]), new Map(), none, 1000, 500);
        expect([...first.settled]).toEqual([]);
        const second = settleBarren(new Set([`a`]), first.firstSeen, none, 1600, 500);
        expect([...second.settled]).toEqual([`a`]);
    });

    it(`forgets a path that left the set — re-emptying restarts the clock`, () => {
        const first = settleBarren(new Set([`a`]), new Map(), none, 1000, 500);
        const gone = settleBarren(new Set(), first.firstSeen, none, 1200, 500);
        expect(gone.firstSeen.has(`a`)).toBe(false);
        const back = settleBarren(new Set([`a`]), gone.firstSeen, none, 1300, 500);
        expect([...back.settled]).toEqual([]);
    });

    it(`never settles an exempt path however long it holds`, () => {
        const first = settleBarren(new Set([`a`]), new Map(), new Set([`a`]), 0, 500);
        const later = settleBarren(new Set([`a`]), first.firstSeen, new Set([`a`]), 10_000, 500);
        expect([...later.settled]).toEqual([]);
    });
});
